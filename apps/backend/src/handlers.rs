use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{get, post},
};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::{CurrentUser, require_auth},
    error::ApiError,
    state::AppState,
};

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: &'a str,
    status: &'a str,
    supabase_url: String,
}

#[derive(Serialize, FromRow)]
struct ProfileRecord {
    id: Uuid,
    phone_e164: String,
}

#[derive(Serialize)]
struct MeResponse {
    id: Uuid,
    phone_e164: String,
}

#[derive(Deserialize)]
struct SearchUsersQuery {
    phone: String,
}

#[derive(Serialize)]
struct UserSearchResponse {
    id: Uuid,
    phone_e164: String,
}

#[derive(Serialize, FromRow)]
struct ChatSummaryRow {
    id: Uuid,
    peer_id: Uuid,
    peer_phone_e164: String,
    last_message: Option<String>,
    last_message_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
struct ChatSummary {
    id: Uuid,
    peer: UserSearchResponse,
    last_message: Option<String>,
    last_message_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct CreateDirectChatRequest {
    peer_user_id: Uuid,
}

#[derive(Serialize, FromRow)]
struct MessageRecord {
    id: Uuid,
    chat_id: Uuid,
    sender_id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
struct SendMessageRequest {
    body: String,
}

#[derive(Deserialize)]
struct MessageHistoryQuery {
    limit: Option<i64>,
    before: Option<DateTime<Utc>>,
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/me", get(me))
        .route("/users/search", get(search_user))
        .route("/chats", get(list_chats))
        .route("/chats/direct", post(create_or_get_direct_chat))
        .route("/chats/{chat_id}/messages", get(list_messages).post(send_message))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            require_auth,
        ));

    Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .merge(protected)
        .with_state(state)
}

async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let payload = HealthResponse {
        service: "messenger-backend",
        status: "ok",
        supabase_url: state.config.supabase_url.clone(),
    };
    (StatusCode::OK, Json(payload))
}

async fn ready(State(state): State<AppState>) -> impl IntoResponse {
    match sqlx::query_scalar::<_, i64>("select 1")
        .fetch_one(&state.db)
        .await
    {
        Ok(_) => StatusCode::OK,
        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
    }
}

async fn me(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<MeResponse>, ApiError> {
    let profile = profile_by_id(&state.db, user.id).await?;

    Ok(Json(MeResponse {
        id: profile.id,
        phone_e164: canonical_phone(&profile.phone_e164),
    }))
}

async fn search_user(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<SearchUsersQuery>,
) -> Result<Json<UserSearchResponse>, ApiError> {
    let phone_digits = phone_digits(&query.phone)?;

    let found = sqlx::query_as::<_, ProfileRecord>(
        r#"
        select id, phone_e164
        from public.profiles
        where regexp_replace(phone_e164, '\D', '', 'g') = $1
          and id <> $2
        limit 1
        "#,
    )
    .bind(phone_digits)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;

    let found = found.ok_or_else(|| ApiError::NotFound("user not found".to_string()))?;

    Ok(Json(UserSearchResponse {
        id: found.id,
        phone_e164: canonical_phone(&found.phone_e164),
    }))
}

async fn list_chats(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<Json<Vec<ChatSummary>>, ApiError> {
    let rows = sqlx::query_as::<_, ChatSummaryRow>(
        r#"
        select
            c.id,
            peer.id as peer_id,
            peer.phone_e164 as peer_phone_e164,
            lm.body as last_message,
            lm.created_at as last_message_at
        from public.chats c
        join public.chat_members self_member
            on self_member.chat_id = c.id
           and self_member.user_id = $1
        join public.chat_members peer_member
            on peer_member.chat_id = c.id
           and peer_member.user_id <> $1
        join public.profiles peer
            on peer.id = peer_member.user_id
        left join lateral (
            select m.body, m.created_at
            from public.messages m
            where m.chat_id = c.id
            order by m.created_at desc
            limit 1
        ) lm on true
        where c.is_group = false
        order by coalesce(lm.created_at, c.created_at) desc
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let chats = rows
        .into_iter()
        .map(|row| ChatSummary {
            id: row.id,
            peer: UserSearchResponse {
                id: row.peer_id,
                phone_e164: canonical_phone(&row.peer_phone_e164),
            },
            last_message: row.last_message,
            last_message_at: row.last_message_at,
        })
        .collect();

    Ok(Json(chats))
}

async fn create_or_get_direct_chat(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<CreateDirectChatRequest>,
) -> Result<(StatusCode, Json<ChatSummary>), ApiError> {
    if payload.peer_user_id == user.id {
        return Err(ApiError::BadRequest(
            "cannot create a chat with yourself".to_string(),
        ));
    }

    let peer = profile_by_id(&state.db, payload.peer_user_id).await?;
    let dm_key = dm_key(user.id, payload.peer_user_id);
    let mut tx = state.db.begin().await?;

    let chat_id = find_or_create_direct_chat(&mut tx, &dm_key, user.id, payload.peer_user_id).await?;
    tx.commit().await?;

    let summary = fetch_chat_summary(&state.db, chat_id, user.id, Some(peer)).await?;

    Ok((StatusCode::OK, Json(summary)))
}

async fn list_messages(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(chat_id): Path<Uuid>,
    Query(query): Query<MessageHistoryQuery>,
) -> Result<Json<Vec<MessageRecord>>, ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let mut messages = sqlx::query_as::<_, MessageRecord>(
        r#"
        select id, chat_id, sender_id, body, created_at, updated_at
        from public.messages
        where chat_id = $1
          and ($2::timestamptz is null or created_at < $2)
        order by created_at desc
        limit $3
        "#,
    )
    .bind(chat_id)
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    messages.reverse();

    Ok(Json(messages))
}

async fn send_message(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(chat_id): Path<Uuid>,
    Json(payload): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<MessageRecord>), ApiError> {
    let body = normalize_message_body(payload.body)?;
    ensure_chat_membership(&state.db, chat_id, user.id).await?;

    let message = sqlx::query_as::<_, MessageRecord>(
        r#"
        insert into public.messages (chat_id, sender_id, body)
        values ($1, $2, $3)
        returning id, chat_id, sender_id, body, created_at, updated_at
        "#,
    )
    .bind(chat_id)
    .bind(user.id)
    .bind(body)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(message)))
}

async fn profile_by_id(db: &PgPool, user_id: Uuid) -> Result<ProfileRecord, ApiError> {
    sqlx::query_as::<_, ProfileRecord>(
        r#"
        select id, phone_e164
        from public.profiles
        where id = $1
        "#,
    )
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::NotFound("profile not found".to_string()))
}

async fn ensure_chat_membership(db: &PgPool, chat_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
    let is_member = sqlx::query_scalar::<_, bool>(
        r#"
        select exists(
            select 1
            from public.chat_members
            where chat_id = $1 and user_id = $2
        )
        "#,
    )
    .bind(chat_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;

    if is_member {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "user is not a member of this chat".to_string(),
        ))
    }
}

async fn find_or_create_direct_chat(
    tx: &mut Transaction<'_, Postgres>,
    dm_key: &str,
    current_user_id: Uuid,
    peer_user_id: Uuid,
) -> Result<Uuid, ApiError> {
    if let Some(existing_chat_id) = sqlx::query_scalar::<_, Uuid>(
        r#"
        select c.id
        from public.chats c
        join public.chat_members self_member
            on self_member.chat_id = c.id
           and self_member.user_id = $2
        join public.chat_members peer_member
            on peer_member.chat_id = c.id
           and peer_member.user_id = $3
        where c.dm_key = $1
        limit 1
        "#,
    )
    .bind(dm_key)
    .bind(current_user_id)
    .bind(peer_user_id)
    .fetch_optional(tx.as_mut())
    .await?
    {
        return Ok(existing_chat_id);
    }

    let chat_id = sqlx::query_scalar::<_, Uuid>(
        r#"
        insert into public.chats (title, is_group, created_by, dm_key)
        values (null, false, $2, $1)
        on conflict (dm_key) do update
            set dm_key = excluded.dm_key
        returning id
        "#,
    )
    .bind(dm_key)
    .bind(current_user_id)
    .fetch_one(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        insert into public.chat_members (chat_id, user_id)
        values ($1, $2), ($1, $3)
        on conflict do nothing
        "#,
    )
    .bind(chat_id)
    .bind(current_user_id)
    .bind(peer_user_id)
    .execute(tx.as_mut())
    .await?;

    Ok(chat_id)
}

async fn fetch_chat_summary(
    db: &PgPool,
    chat_id: Uuid,
    current_user_id: Uuid,
    peer_hint: Option<ProfileRecord>,
) -> Result<ChatSummary, ApiError> {
    let row = sqlx::query_as::<_, ChatSummaryRow>(
        r#"
        select
            c.id,
            peer.id as peer_id,
            peer.phone_e164 as peer_phone_e164,
            lm.body as last_message,
            lm.created_at as last_message_at
        from public.chats c
        join public.chat_members self_member
            on self_member.chat_id = c.id
           and self_member.user_id = $2
        join public.chat_members peer_member
            on peer_member.chat_id = c.id
           and peer_member.user_id <> $2
        join public.profiles peer
            on peer.id = peer_member.user_id
        left join lateral (
            select m.body, m.created_at
            from public.messages m
            where m.chat_id = c.id
            order by m.created_at desc
            limit 1
        ) lm on true
        where c.id = $1
        limit 1
        "#,
    )
    .bind(chat_id)
    .bind(current_user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::NotFound("chat not found".to_string()))?;

    let peer = peer_hint.unwrap_or(ProfileRecord {
        id: row.peer_id,
        phone_e164: row.peer_phone_e164.clone(),
    });

    Ok(ChatSummary {
        id: row.id,
        peer: UserSearchResponse {
            id: peer.id,
            phone_e164: canonical_phone(&peer.phone_e164),
        },
        last_message: row.last_message,
        last_message_at: row.last_message_at,
    })
}

fn dm_key(left: Uuid, right: Uuid) -> String {
    let mut ids = [left.to_string(), right.to_string()];
    ids.sort();
    format!("{}:{}", ids[0], ids[1])
}

fn normalize_message_body(body: String) -> Result<String, ApiError> {
    let body = body.trim().to_string();

    if body.is_empty() {
        return Err(ApiError::BadRequest(
            "message body must not be empty".to_string(),
        ));
    }

    if body.chars().count() > 4000 {
        return Err(ApiError::BadRequest(
            "message body must not exceed 4000 characters".to_string(),
        ));
    }

    Ok(body)
}

fn canonical_phone(value: &str) -> String {
    let digits: String = value.chars().filter(|char| char.is_ascii_digit()).collect();

    if digits.is_empty() {
        value.trim().to_string()
    } else {
        format!("+{digits}")
    }
}

fn phone_digits(value: &str) -> Result<String, ApiError> {
    let digits: String = value.chars().filter(|char| char.is_ascii_digit()).collect();

    if digits.is_empty() {
        return Err(ApiError::BadRequest(
            "phone number must contain digits".to_string(),
        ));
    }

    Ok(digits)
}

#[cfg(test)]
mod tests {
    use super::{canonical_phone, dm_key, normalize_message_body, phone_digits};
    use uuid::uuid;

    #[test]
    fn rejects_blank_message_body() {
        let result = normalize_message_body("   ".to_string());
        assert!(result.is_err());
    }

    #[test]
    fn trims_message_body() {
        let result = normalize_message_body("  hello  ".to_string()).unwrap();
        assert_eq!(result, "hello");
    }

    #[test]
    fn builds_stable_direct_message_key() {
        let left = uuid!("00000000-0000-0000-0000-000000000002");
        let right = uuid!("00000000-0000-0000-0000-000000000001");
        assert_eq!(
            dm_key(left, right),
            "00000000-0000-0000-0000-000000000001:00000000-0000-0000-0000-000000000002"
        );
    }

    #[test]
    fn canonicalizes_phone_to_e164_like_format() {
        assert_eq!(canonical_phone("380966299221"), "+380966299221");
        assert_eq!(canonical_phone("+380 97 892 8141"), "+380978928141");
    }

    #[test]
    fn extracts_digits_for_search() {
        assert_eq!(phone_digits("+380 97 892 8141").unwrap(), "380978928141");
    }
}

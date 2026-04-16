use std::collections::BTreeSet;

use axum::{
    Extension, Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    middleware,
    response::IntoResponse,
    routing::{get, patch, post},
};
use chrono::{DateTime, Duration, Utc};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sqlx::{FromRow, PgPool, Postgres, Transaction};
use uuid::Uuid;

use crate::{
    auth::{CurrentUser, canonical_phone, rate_limit_search, require_auth},
    error::ApiError,
    state::AppState,
};

const ONLINE_WINDOW_SECONDS: i64 = 90;
const CHAT_PAGE_SIZE_DEFAULT: i64 = 30;
const CHAT_PAGE_SIZE_MAX: i64 = 100;

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: &'a str,
    status: &'a str,
    supabase_url: String,
}

#[derive(Clone, Debug, FromRow)]
struct ProfileRecord {
    id: Uuid,
    phone_e164: String,
    username: Option<String>,
    avatar_path: Option<String>,
    last_seen_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
struct UserProfile {
    id: Uuid,
    phone_e164: String,
    username: Option<String>,
    avatar_path: Option<String>,
    last_seen_at: Option<DateTime<Utc>>,
    is_online: bool,
}

#[derive(Serialize)]
struct MeResponse {
    id: Uuid,
    phone_e164: String,
    username: Option<String>,
    avatar_path: Option<String>,
    last_seen_at: Option<DateTime<Utc>>,
    is_online: bool,
}

#[derive(Deserialize)]
struct UpdateProfileRequest {
    username: Option<String>,
    avatar_path: Option<String>,
}

#[derive(Deserialize)]
struct SearchUsersQuery {
    username: String,
}

#[derive(Deserialize)]
struct DiscoverContactsRequest {
    phones: Vec<String>,
}

#[derive(Deserialize)]
struct ListChatsQuery {
    limit: Option<i64>,
    before: Option<DateTime<Utc>>,
}

#[derive(Serialize, FromRow)]
struct ChatSummaryRow {
    id: Uuid,
    peer_id: Uuid,
    peer_phone_e164: String,
    peer_username: Option<String>,
    peer_avatar_path: Option<String>,
    peer_last_seen_at: Option<DateTime<Utc>>,
    last_message: Option<String>,
    last_message_at: Option<DateTime<Utc>>,
    activity_at: DateTime<Utc>,
    unread_count: i64,
    is_archived: bool,
    is_pinned: bool,
    is_muted: bool,
}

#[derive(Serialize)]
struct ChatSummary {
    id: Uuid,
    peer: UserProfile,
    last_message: Option<String>,
    last_message_at: Option<DateTime<Utc>>,
    activity_at: DateTime<Utc>,
    unread_count: i64,
    is_archived: bool,
    is_pinned: bool,
    is_muted: bool,
}

#[derive(Deserialize)]
struct CreateDirectChatRequest {
    peer_user_id: Uuid,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReceiptStatus {
    Sent,
    Delivered,
    Seen,
}

#[derive(Serialize, FromRow)]
struct MessageRecordRow {
    id: Uuid,
    chat_id: Uuid,
    sender_id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    receipt_status: Option<String>,
    reply_to_id: Option<Uuid>,
    reply_to_sender_id: Option<Uuid>,
    reply_to_body: Option<String>,
    reply_to_deleted_at: Option<DateTime<Utc>>,
    forwarded_from_id: Option<Uuid>,
    forwarded_from_sender_id: Option<Uuid>,
    forwarded_from_body: Option<String>,
    forwarded_from_deleted_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Debug, Serialize)]
struct MessagePreview {
    id: Uuid,
    sender_id: Uuid,
    body: String,
    is_deleted: bool,
}

#[derive(Clone, Debug, Serialize)]
struct MessageRecord {
    id: Uuid,
    chat_id: Uuid,
    sender_id: Uuid,
    body: String,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
    edited_at: Option<DateTime<Utc>>,
    deleted_at: Option<DateTime<Utc>>,
    receipt_status: Option<ReceiptStatus>,
    reply_to: Option<MessagePreview>,
    forwarded_from: Option<MessagePreview>,
}

#[derive(Deserialize)]
struct SendMessageRequest {
    body: String,
    reply_to_message_id: Option<Uuid>,
    forwarded_from_message_id: Option<Uuid>,
}

#[derive(Deserialize)]
struct MessageHistoryQuery {
    limit: Option<i64>,
    before: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct PushTokenRequest {
    expo_push_token: String,
    platform: String,
}

#[derive(Deserialize)]
struct UpsertDeviceKeysRequest {
    device_id: Uuid,
    registration_id: i32,
    identity_key: String,
    signed_prekey: SignedPreKeyUpload,
    one_time_prekeys: Vec<OneTimePreKeyUpload>,
}

#[derive(Deserialize)]
struct SignedPreKeyUpload {
    key_id: i32,
    public_key: String,
    signature: String,
}

#[derive(Clone, Deserialize)]
struct OneTimePreKeyUpload {
    key_id: i32,
    public_key: String,
}

#[derive(Serialize)]
struct DeviceKeysResponse {
    device_id: Uuid,
    registration_id: i32,
    uploaded_one_time_prekeys: usize,
}

#[derive(Serialize, FromRow)]
struct DeviceBundleRow {
    device_id: Uuid,
    registration_id: i32,
    identity_key: String,
    signed_prekey_id: i32,
    signed_prekey_public: String,
    signed_prekey_signature: String,
}

#[derive(Clone, Serialize, FromRow)]
struct ClaimedOneTimePreKey {
    key_id: i32,
    public_key: String,
}

#[derive(Serialize)]
struct DeviceBundleResponse {
    device_id: Uuid,
    registration_id: i32,
    identity_key: String,
    signed_prekey: SignedPreKeyResponse,
    one_time_prekey: Option<OneTimePreKeyResponse>,
}

#[derive(Serialize)]
struct SignedPreKeyResponse {
    key_id: i32,
    public_key: String,
    signature: String,
}

#[derive(Clone, Serialize)]
struct OneTimePreKeyResponse {
    key_id: i32,
    public_key: String,
}

#[derive(Deserialize)]
struct EnqueuePendingMessageRequest {
    sender_device_id: Uuid,
    receiver_device_id: Uuid,
    message_type: i16,
    ciphertext: String,
    client_message_id: Option<Uuid>,
}

#[derive(Serialize, FromRow)]
struct PendingMessageRow {
    id: Uuid,
    sender_user_id: Uuid,
    sender_device_id: Uuid,
    receiver_device_id: Uuid,
    message_type: i16,
    ciphertext: String,
    client_message_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    delivered_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
struct PendingMessageResponse {
    id: Uuid,
    sender_user_id: Uuid,
    sender_device_id: Uuid,
    receiver_device_id: Uuid,
    message_type: i16,
    ciphertext: String,
    client_message_id: Option<Uuid>,
    created_at: DateTime<Utc>,
    delivered_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct UpdateMessageRequest {
    body: String,
}

#[derive(Deserialize)]
struct DeleteMessageRequest {
    scope: DeleteMessageScope,
}

#[derive(Deserialize)]
struct ClearChatRequest {
    scope: ClearChatScope,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ClearChatScope {
    SelfOnly,
    Everyone,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "snake_case")]
enum DeleteMessageScope {
    SelfOnly,
    Everyone,
}

#[derive(Deserialize)]
struct UpdateChatPreferencesRequest {
    archived: Option<bool>,
    pinned: Option<bool>,
    muted: Option<bool>,
}

pub fn router(state: AppState) -> Router {
    let protected = Router::new()
        .route("/me", get(me).patch(update_me))
        .route("/presence/heartbeat", post(heartbeat))
        .route("/devices/push-token", post(upsert_push_token))
        .route("/devices/push-token/remove", post(remove_push_token))
        .route("/e2ee/devices/keys", post(upsert_device_keys))
        .route(
            "/e2ee/users/{user_id}/device-bundles",
            get(list_device_bundles),
        )
        .route("/e2ee/messages", post(enqueue_pending_message))
        .route(
            "/e2ee/devices/{device_id}/pending-messages",
            get(list_pending_messages),
        )
        .route(
            "/e2ee/devices/{device_id}/pending-messages/{pending_message_id}/ack",
            post(ack_pending_message),
        )
        .route(
            "/users/search",
            get(search_user).route_layer(middleware::from_fn_with_state(
                state.clone(),
                rate_limit_search,
            )),
        )
        .route("/contacts/discover", post(discover_contacts))
        .route("/chats", get(list_chats))
        .route("/chats/{chat_id}", axum::routing::delete(delete_chat))
        .route(
            "/chats/{chat_id}/preferences",
            patch(update_chat_preferences),
        )
        .route("/chats/{chat_id}/clear", post(clear_chat_history))
        .route("/chats/direct", post(create_or_get_direct_chat))
        .route(
            "/chats/{chat_id}/messages",
            get(list_messages).post(send_message),
        )
        .route(
            "/chats/{chat_id}/messages/{message_id}",
            patch(edit_message),
        )
        .route(
            "/chats/{chat_id}/messages/{message_id}/delete",
            post(delete_message),
        )
        .route_layer(middleware::from_fn_with_state(state.clone(), require_auth));

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
    let payload = to_user_profile(profile);

    Ok(Json(MeResponse {
        id: payload.id,
        phone_e164: payload.phone_e164,
        username: payload.username,
        avatar_path: payload.avatar_path,
        last_seen_at: payload.last_seen_at,
        is_online: payload.is_online,
    }))
}

async fn update_me(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<UpdateProfileRequest>,
) -> Result<Json<MeResponse>, ApiError> {
    let username = normalize_username(payload.username)?;
    let avatar_path = normalize_avatar_path(user.id, payload.avatar_path)?;

    let profile = sqlx::query_as::<_, ProfileRecord>(
        r#"
        update public.profiles
        set username = $2,
            avatar_path = $3
        where id = $1
        returning id, phone_e164, username, avatar_path, last_seen_at
        "#,
    )
    .bind(user.id)
    .bind(username)
    .bind(avatar_path)
    .fetch_one(&state.db)
    .await
    .map_err(map_profile_update_error)?;

    let payload = to_user_profile(profile);

    Ok(Json(MeResponse {
        id: payload.id,
        phone_e164: payload.phone_e164,
        username: payload.username,
        avatar_path: payload.avatar_path,
        last_seen_at: payload.last_seen_at,
        is_online: payload.is_online,
    }))
}

async fn heartbeat(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
) -> Result<StatusCode, ApiError> {
    touch_presence(&state.db, user.id).await?;
    Ok(StatusCode::NO_CONTENT)
}

async fn upsert_push_token(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<PushTokenRequest>,
) -> Result<StatusCode, ApiError> {
    let expo_push_token = normalize_push_token(payload.expo_push_token)?;
    let platform = normalize_platform(payload.platform)?;

    sqlx::query(
        r#"
        insert into public.user_devices (user_id, expo_push_token, platform)
        values ($1, $2, $3)
        on conflict (expo_push_token) do update
        set user_id = excluded.user_id,
            platform = excluded.platform,
            updated_at = timezone('utc', now())
        "#,
    )
    .bind(user.id)
    .bind(expo_push_token)
    .bind(platform)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn remove_push_token(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<PushTokenRequest>,
) -> Result<StatusCode, ApiError> {
    let expo_push_token = normalize_push_token(payload.expo_push_token)?;

    sqlx::query(
        r#"
        delete from public.user_devices
        where user_id = $1
          and expo_push_token = $2
        "#,
    )
    .bind(user.id)
    .bind(expo_push_token)
    .execute(&state.db)
    .await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn upsert_device_keys(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<UpsertDeviceKeysRequest>,
) -> Result<Json<DeviceKeysResponse>, ApiError> {
    let identity_key = normalize_key_material(payload.identity_key, "identity_key")?;
    let signed_prekey_public =
        normalize_key_material(payload.signed_prekey.public_key, "signed_prekey.public_key")?;
    let signed_prekey_signature =
        normalize_key_material(payload.signed_prekey.signature, "signed_prekey.signature")?;
    let one_time_prekeys = normalize_one_time_prekeys(payload.one_time_prekeys)?;

    if let Some(existing_owner) = sqlx::query_scalar::<_, Uuid>(
        r#"
        select user_id
        from public.e2ee_devices
        where id = $1
        "#,
    )
    .bind(payload.device_id)
    .fetch_optional(&state.db)
    .await?
        && existing_owner != user.id
    {
        return Err(ApiError::Status(
            StatusCode::CONFLICT,
            "device_id is already registered to another user".to_string(),
        ));
    }

    let mut tx = state.db.begin().await?;

    sqlx::query(
        r#"
        insert into public.e2ee_devices (
            id,
            user_id,
            registration_id,
            identity_key,
            signed_prekey_id,
            signed_prekey_public,
            signed_prekey_signature
        )
        values ($1, $2, $3, $4, $5, $6, $7)
        on conflict (id) do update
        set registration_id = excluded.registration_id,
            identity_key = excluded.identity_key,
            signed_prekey_id = excluded.signed_prekey_id,
            signed_prekey_public = excluded.signed_prekey_public,
            signed_prekey_signature = excluded.signed_prekey_signature,
            updated_at = timezone('utc', now())
        "#,
    )
    .bind(payload.device_id)
    .bind(user.id)
    .bind(payload.registration_id)
    .bind(identity_key)
    .bind(payload.signed_prekey.key_id)
    .bind(signed_prekey_public)
    .bind(signed_prekey_signature)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        delete from public.e2ee_one_time_prekeys
        where device_id = $1
        "#,
    )
    .bind(payload.device_id)
    .execute(tx.as_mut())
    .await?;

    for prekey in &one_time_prekeys {
        sqlx::query(
            r#"
            insert into public.e2ee_one_time_prekeys (
                device_id,
                key_id,
                public_key
            )
            values ($1, $2, $3)
            "#,
        )
        .bind(payload.device_id)
        .bind(prekey.key_id)
        .bind(&prekey.public_key)
        .execute(tx.as_mut())
        .await?;
    }

    tx.commit().await?;

    Ok(Json(DeviceKeysResponse {
        device_id: payload.device_id,
        registration_id: payload.registration_id,
        uploaded_one_time_prekeys: one_time_prekeys.len(),
    }))
}

async fn list_device_bundles(
    State(state): State<AppState>,
    Extension(_user): Extension<CurrentUser>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<Vec<DeviceBundleResponse>>, ApiError> {
    profile_by_id(&state.db, user_id).await?;

    let mut tx = state.db.begin().await?;
    let device_rows = sqlx::query_as::<_, DeviceBundleRow>(
        r#"
        select
            id as device_id,
            registration_id,
            identity_key,
            signed_prekey_id,
            signed_prekey_public,
            signed_prekey_signature
        from public.e2ee_devices
        where user_id = $1
        order by created_at asc, id asc
        "#,
    )
    .bind(user_id)
    .fetch_all(tx.as_mut())
    .await?;

    if device_rows.is_empty() {
        return Err(ApiError::NotFound(
            "target user has no registered device keys".to_string(),
        ));
    }

    let mut bundles = Vec::with_capacity(device_rows.len());
    for row in device_rows {
        let one_time_prekey =
            consume_one_time_prekey(&mut tx, row.device_id)
                .await?
                .map(|prekey| OneTimePreKeyResponse {
                    key_id: prekey.key_id,
                    public_key: prekey.public_key,
                });

        bundles.push(DeviceBundleResponse {
            device_id: row.device_id,
            registration_id: row.registration_id,
            identity_key: row.identity_key,
            signed_prekey: SignedPreKeyResponse {
                key_id: row.signed_prekey_id,
                public_key: row.signed_prekey_public,
                signature: row.signed_prekey_signature,
            },
            one_time_prekey,
        });
    }

    tx.commit().await?;

    Ok(Json(bundles))
}

async fn enqueue_pending_message(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<EnqueuePendingMessageRequest>,
) -> Result<(StatusCode, Json<PendingMessageResponse>), ApiError> {
    ensure_device_ownership(&state.db, payload.sender_device_id, user.id).await?;
    ensure_device_exists(&state.db, payload.receiver_device_id).await?;

    let ciphertext = normalize_key_material(payload.ciphertext, "ciphertext")?;
    let message_type = normalize_message_type(payload.message_type)?;

    let row = sqlx::query_as::<_, PendingMessageRow>(
        r#"
        insert into public.e2ee_pending_messages (
            receiver_device_id,
            sender_user_id,
            sender_device_id,
            message_type,
            ciphertext,
            client_message_id
        )
        values ($1, $2, $3, $4, $5, $6)
        returning
            id,
            sender_user_id,
            sender_device_id,
            receiver_device_id,
            message_type,
            ciphertext,
            client_message_id,
            created_at,
            delivered_at
        "#,
    )
    .bind(payload.receiver_device_id)
    .bind(user.id)
    .bind(payload.sender_device_id)
    .bind(message_type)
    .bind(ciphertext)
    .bind(payload.client_message_id)
    .fetch_one(&state.db)
    .await?;

    Ok((StatusCode::CREATED, Json(to_pending_message_response(row))))
}

async fn list_pending_messages(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(device_id): Path<Uuid>,
) -> Result<Json<Vec<PendingMessageResponse>>, ApiError> {
    ensure_device_ownership(&state.db, device_id, user.id).await?;

    let rows = sqlx::query_as::<_, PendingMessageRow>(
        r#"
        with updated as (
            update public.e2ee_pending_messages
            set delivered_at = coalesce(delivered_at, timezone('utc', now()))
            where receiver_device_id = $1
              and acked_at is null
            returning
                id,
                sender_user_id,
                sender_device_id,
                receiver_device_id,
                message_type,
                ciphertext,
                client_message_id,
                created_at,
                delivered_at
        )
        select *
        from updated
        order by created_at asc, id asc
        "#,
    )
    .bind(device_id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(
        rows.into_iter().map(to_pending_message_response).collect(),
    ))
}

async fn ack_pending_message(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((device_id, pending_message_id)): Path<(Uuid, Uuid)>,
) -> Result<StatusCode, ApiError> {
    ensure_device_ownership(&state.db, device_id, user.id).await?;

    let deleted = sqlx::query(
        r#"
        with acked as (
            update public.e2ee_pending_messages
            set acked_at = timezone('utc', now())
            where id = $1
              and receiver_device_id = $2
              and acked_at is null
            returning id
        )
        delete from public.e2ee_pending_messages
        where id in (select id from acked)
        "#,
    )
    .bind(pending_message_id)
    .bind(device_id)
    .execute(&state.db)
    .await?
    .rows_affected();

    if deleted == 0 {
        return Err(ApiError::NotFound("pending message not found".to_string()));
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn search_user(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<SearchUsersQuery>,
) -> Result<Json<Vec<UserProfile>>, ApiError> {
    let username = normalize_username(Some(query.username))?
        .ok_or_else(|| ApiError::BadRequest("username must not be empty".to_string()))?;
    let pattern = format!("{username}%");

    let found = sqlx::query_as::<_, ProfileRecord>(
        r#"
        select id, phone_e164, username, avatar_path, last_seen_at
        from public.profiles
        where username is not null
          and username ilike $1
          and id <> $2
        order by
            case when username = $3 then 0 else 1 end asc,
            username asc
        limit 20
        "#,
    )
    .bind(pattern)
    .bind(user.id)
    .bind(username)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(found.into_iter().map(to_user_profile).collect()))
}

async fn discover_contacts(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Json(payload): Json<DiscoverContactsRequest>,
) -> Result<Json<Vec<UserProfile>>, ApiError> {
    let phones = normalize_contact_phones(payload.phones)?;

    if phones.is_empty() {
        return Ok(Json(Vec::new()));
    }

    let rows = sqlx::query_as::<_, ProfileRecord>(
        r#"
        select id, phone_e164, username, avatar_path, last_seen_at
        from public.profiles
        where regexp_replace(phone_e164, '\D', '', 'g') = any($1)
          and id <> $2
        order by coalesce(username, phone_e164) asc
        limit 100
        "#,
    )
    .bind(&phones)
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(to_user_profile).collect()))
}

async fn list_chats(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Query(query): Query<ListChatsQuery>,
) -> Result<Json<Vec<ChatSummary>>, ApiError> {
    touch_all_deliveries(&state.db, user.id).await?;
    let limit = query
        .limit
        .unwrap_or(CHAT_PAGE_SIZE_DEFAULT)
        .clamp(1, CHAT_PAGE_SIZE_MAX);

    let rows = sqlx::query_as::<_, ChatSummaryRow>(
        r#"
        select
            c.id,
            peer.id as peer_id,
            peer.phone_e164 as peer_phone_e164,
            peer.username as peer_username,
            peer.avatar_path as peer_avatar_path,
            peer.last_seen_at as peer_last_seen_at,
            case
                when lm.deleted_at is not null then 'Message deleted'
                else lm.body
            end as last_message,
            lm.created_at as last_message_at,
            coalesce(lm.created_at, c.created_at) as activity_at,
            coalesce(unread.unread_count, 0) as unread_count,
            self_member.archived_at is not null as is_archived,
            self_member.pinned_at is not null as is_pinned,
            self_member.muted_until is not null
                and self_member.muted_until > timezone('utc', now()) as is_muted
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
            select m.body, m.created_at, m.deleted_at
            from public.messages m
            where m.chat_id = c.id
              and not exists (
                  select 1
                  from public.message_hidden_for_users hidden
                  where hidden.message_id = m.id
                    and hidden.user_id = $1
              )
              and (
                  self_member.cleared_at is null
                  or m.created_at > self_member.cleared_at
              )
            order by m.created_at desc
            limit 1
        ) lm on true
        left join lateral (
            select count(*)::bigint as unread_count
            from public.messages m
            where m.chat_id = c.id
              and m.sender_id <> $1
              and m.deleted_at is null
              and not exists (
                  select 1
                  from public.message_hidden_for_users hidden
                  where hidden.message_id = m.id
                    and hidden.user_id = $1
              )
              and (
                  self_member.cleared_at is null
                  or m.created_at > self_member.cleared_at
              )
              and (
                  self_member.last_read_at is null
                  or m.created_at > self_member.last_read_at
              )
        ) unread on true
        where c.is_group = false
          and ($2::timestamptz is null or coalesce(lm.created_at, c.created_at) < $2)
        order by coalesce(lm.created_at, c.created_at) desc, c.id desc
        limit $3
        "#,
    )
    .bind(user.id)
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(to_chat_summary).collect()))
}

async fn delete_chat(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(chat_id): Path<Uuid>,
) -> Result<StatusCode, ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;

    let mut tx = state.db.begin().await?;
    sqlx::query(
        r#"
        delete from public.chat_members
        where chat_id = $1
          and user_id = $2
        "#,
    )
    .bind(chat_id)
    .bind(user.id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        delete from public.chats c
        where c.id = $1
          and not exists (
              select 1
              from public.chat_members cm
              where cm.chat_id = c.id
          )
        "#,
    )
    .bind(chat_id)
    .execute(tx.as_mut())
    .await?;

    tx.commit().await?;

    Ok(StatusCode::NO_CONTENT)
}

async fn update_chat_preferences(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(chat_id): Path<Uuid>,
    Json(payload): Json<UpdateChatPreferencesRequest>,
) -> Result<Json<ChatSummary>, ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;
    sqlx::query(
        r#"
        update public.chat_members
        set archived_at = case
                when $3::bool is null then archived_at
                when $3 then timezone('utc', now())
                else null
            end,
            pinned_at = case
                when $4::bool is null then pinned_at
                when $4 then coalesce(pinned_at, timezone('utc', now()))
                else null
            end,
            muted_until = case
                when $5::bool is null then muted_until
                when $5 then 'infinity'::timestamptz
                else null
            end
        where chat_id = $1
          and user_id = $2
        "#,
    )
    .bind(chat_id)
    .bind(user.id)
    .bind(payload.archived)
    .bind(payload.pinned)
    .bind(payload.muted)
    .execute(&state.db)
    .await?;

    let summary = fetch_chat_summary(&state.db, chat_id, user.id, None).await?;
    Ok(Json(summary))
}

async fn clear_chat_history(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(chat_id): Path<Uuid>,
    Json(payload): Json<ClearChatRequest>,
) -> Result<StatusCode, ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;
    match payload.scope {
        ClearChatScope::SelfOnly => clear_chat_for_self(&state.db, chat_id, user.id).await?,
        ClearChatScope::Everyone => clear_chat_for_everyone(&state.db, chat_id).await?,
    }

    Ok(StatusCode::NO_CONTENT)
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

    let chat_id =
        find_or_create_direct_chat(&mut tx, &dm_key, user.id, payload.peer_user_id).await?;
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
    touch_chat_delivery(&state.db, chat_id, user.id).await?;

    let limit = query.limit.unwrap_or(50).clamp(1, 100);
    let mut messages = sqlx::query_as::<_, MessageRecordRow>(
        r#"
        select
            m.id,
            m.chat_id,
            m.sender_id,
            case
                when m.deleted_at is not null then ''
                else m.body
            end as body,
            m.created_at,
            m.updated_at,
            m.edited_at,
            m.deleted_at,
            case
                when m.sender_id <> $2 or m.deleted_at is not null then null
                when peer_member.last_read_at is not null and peer_member.last_read_at >= m.created_at then 'seen'
                when peer_member.last_delivered_at is not null and peer_member.last_delivered_at >= m.created_at then 'delivered'
                else 'sent'
            end as receipt_status,
            reply_msg.id as reply_to_id,
            reply_msg.sender_id as reply_to_sender_id,
            case
                when reply_msg.id is null then null
                when reply_msg.deleted_at is not null then 'Deleted message'
                else reply_msg.body
            end as reply_to_body,
            reply_msg.deleted_at as reply_to_deleted_at,
            forwarded_msg.id as forwarded_from_id,
            forwarded_msg.sender_id as forwarded_from_sender_id,
            case
                when forwarded_msg.id is null then null
                when forwarded_msg.deleted_at is not null then 'Deleted message'
                else forwarded_msg.body
            end as forwarded_from_body,
            forwarded_msg.deleted_at as forwarded_from_deleted_at
        from public.messages m
        join public.chat_members self_member
            on self_member.chat_id = m.chat_id
           and self_member.user_id = $2
        left join public.chat_members peer_member
            on peer_member.chat_id = m.chat_id
           and peer_member.user_id <> $2
        left join public.messages reply_msg
            on reply_msg.id = m.reply_to_message_id
           and not exists (
               select 1
               from public.message_hidden_for_users hidden
               where hidden.message_id = reply_msg.id
                 and hidden.user_id = $2
           )
        left join public.messages forwarded_msg
            on forwarded_msg.id = m.forwarded_from_message_id
           and not exists (
               select 1
               from public.message_hidden_for_users hidden
               where hidden.message_id = forwarded_msg.id
                 and hidden.user_id = $2
           )
        where m.chat_id = $1
          and not exists (
              select 1
              from public.message_hidden_for_users hidden
              where hidden.message_id = m.id
                and hidden.user_id = $2
          )
          and (
              self_member.cleared_at is null
              or m.created_at > self_member.cleared_at
          )
          and ($3::timestamptz is null or m.created_at < $3)
        order by m.created_at desc
        limit $4
        "#,
    )
    .bind(chat_id)
    .bind(user.id)
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    messages.reverse();

    if let Some(last_message) = messages.last() {
        mark_chat_read(&state.db, chat_id, user.id, Some(last_message.id)).await?;
    } else {
        mark_chat_read(&state.db, chat_id, user.id, None).await?;
    }

    Ok(Json(messages.into_iter().map(to_message_record).collect()))
}

async fn send_message(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path(chat_id): Path<Uuid>,
    Json(payload): Json<SendMessageRequest>,
) -> Result<(StatusCode, Json<MessageRecord>), ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;

    let reply_to_message_id = match payload.reply_to_message_id {
        Some(message_id) => {
            Some(validate_reply_target(&state.db, chat_id, user.id, message_id).await?)
        }
        None => None,
    };

    let (body, forwarded_from_message_id) = match payload.forwarded_from_message_id {
        Some(message_id) => {
            let forwarded = validate_forward_source(&state.db, user.id, message_id).await?;
            (forwarded.body, Some(forwarded.id))
        }
        None => (normalize_message_body(payload.body)?, None),
    };

    let row = sqlx::query_as::<_, MessageRecordRow>(
        r#"
        insert into public.messages (
            chat_id,
            sender_id,
            body,
            reply_to_message_id,
            forwarded_from_message_id
        )
        values ($1, $2, $3, $4, $5)
        returning
            id,
            chat_id,
            sender_id,
            body,
            created_at,
            updated_at,
            edited_at,
            deleted_at,
            'sent' as receipt_status,
            null::uuid as reply_to_id,
            null::uuid as reply_to_sender_id,
            null::text as reply_to_body,
            null::timestamptz as reply_to_deleted_at,
            null::uuid as forwarded_from_id,
            null::uuid as forwarded_from_sender_id,
            null::text as forwarded_from_body,
            null::timestamptz as forwarded_from_deleted_at
        "#,
    )
    .bind(chat_id)
    .bind(user.id)
    .bind(body.clone())
    .bind(reply_to_message_id)
    .bind(forwarded_from_message_id)
    .fetch_one(&state.db)
    .await?;

    let sender_profile = profile_by_id(&state.db, user.id).await?;
    let push_tokens = fetch_push_tokens_for_chat(&state.db, chat_id, user.id).await?;

    if !push_tokens.is_empty() {
        dispatch_push_notifications(
            state.http.clone(),
            sender_profile
                .username
                .unwrap_or_else(|| canonical_phone(&sender_profile.phone_e164)),
            body,
            chat_id,
            push_tokens,
        );
    }

    Ok((StatusCode::CREATED, Json(to_message_record(row))))
}

async fn edit_message(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<UpdateMessageRequest>,
) -> Result<Json<MessageRecord>, ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;
    let body = normalize_message_body(payload.body)?;

    let row = sqlx::query_as::<_, MessageRecordRow>(
        r#"
        update public.messages
        set body = $4,
            edited_at = timezone('utc', now())
        where id = $1
          and chat_id = $2
          and sender_id = $3
          and deleted_at is null
        returning
            id,
            chat_id,
            sender_id,
            body,
            created_at,
            updated_at,
            edited_at,
            deleted_at,
            'sent' as receipt_status,
            null::uuid as reply_to_id,
            null::uuid as reply_to_sender_id,
            null::text as reply_to_body,
            null::timestamptz as reply_to_deleted_at,
            null::uuid as forwarded_from_id,
            null::uuid as forwarded_from_sender_id,
            null::text as forwarded_from_body,
            null::timestamptz as forwarded_from_deleted_at
        "#,
    )
    .bind(message_id)
    .bind(chat_id)
    .bind(user.id)
    .bind(body)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::NotFound("message not found".to_string()))?;

    Ok(Json(to_message_record(row)))
}

async fn delete_message(
    State(state): State<AppState>,
    Extension(user): Extension<CurrentUser>,
    Path((chat_id, message_id)): Path<(Uuid, Uuid)>,
    Json(payload): Json<DeleteMessageRequest>,
) -> Result<StatusCode, ApiError> {
    ensure_chat_membership(&state.db, chat_id, user.id).await?;

    match payload.scope {
        DeleteMessageScope::SelfOnly => {
            hide_message_for_user(&state.db, chat_id, message_id, user.id).await?
        }
        DeleteMessageScope::Everyone => {
            delete_message_for_everyone(&state.db, chat_id, message_id, user.id).await?
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn profile_by_id(db: &PgPool, user_id: Uuid) -> Result<ProfileRecord, ApiError> {
    sqlx::query_as::<_, ProfileRecord>(
        r#"
        select id, phone_e164, username, avatar_path, last_seen_at
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

async fn ensure_device_ownership(
    db: &PgPool,
    device_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        select exists(
            select 1
            from public.e2ee_devices
            where id = $1
              and user_id = $2
        )
        "#,
    )
    .bind(device_id)
    .bind(user_id)
    .fetch_one(db)
    .await?;

    if exists {
        Ok(())
    } else {
        Err(ApiError::Forbidden(
            "device does not belong to the current user".to_string(),
        ))
    }
}

async fn ensure_device_exists(db: &PgPool, device_id: Uuid) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        select exists(
            select 1
            from public.e2ee_devices
            where id = $1
        )
        "#,
    )
    .bind(device_id)
    .fetch_one(db)
    .await?;

    if exists {
        Ok(())
    } else {
        Err(ApiError::NotFound("receiver device not found".to_string()))
    }
}

async fn consume_one_time_prekey(
    tx: &mut Transaction<'_, Postgres>,
    device_id: Uuid,
) -> Result<Option<ClaimedOneTimePreKey>, ApiError> {
    sqlx::query_as::<_, ClaimedOneTimePreKey>(
        r#"
        with claimed as (
            update public.e2ee_one_time_prekeys
            set claimed_at = timezone('utc', now())
            where ctid in (
                select ctid
                from public.e2ee_one_time_prekeys
                where device_id = $1
                  and claimed_at is null
                order by created_at asc, key_id asc
                limit 1
                for update skip locked
            )
            returning key_id, public_key
        )
        select key_id, public_key
        from claimed
        "#,
    )
    .bind(device_id)
    .fetch_optional(tx.as_mut())
    .await
    .map_err(Into::into)
}

async fn touch_presence(db: &PgPool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query("select public.touch_profile_presence($1)")
        .bind(user_id)
        .execute(db)
        .await?;

    Ok(())
}

async fn touch_all_deliveries(db: &PgPool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        update public.chat_members
        set last_delivered_at = timezone('utc', now())
        where user_id = $1
        "#,
    )
    .bind(user_id)
    .execute(db)
    .await?;

    Ok(())
}

async fn touch_chat_delivery(db: &PgPool, chat_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        update public.chat_members
        set last_delivered_at = timezone('utc', now())
        where chat_id = $1
          and user_id = $2
        "#,
    )
    .bind(chat_id)
    .bind(user_id)
    .execute(db)
    .await?;

    Ok(())
}

async fn mark_chat_read(
    db: &PgPool,
    chat_id: Uuid,
    user_id: Uuid,
    last_message_id: Option<Uuid>,
) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        update public.chat_members
        set last_delivered_at = timezone('utc', now()),
            last_read_at = timezone('utc', now()),
            last_read_message_id = coalesce($3, last_read_message_id)
        where chat_id = $1
          and user_id = $2
        "#,
    )
    .bind(chat_id)
    .bind(user_id)
    .bind(last_message_id)
    .execute(db)
    .await?;

    Ok(())
}

#[derive(FromRow)]
struct ForwardSource {
    id: Uuid,
    body: String,
}

async fn validate_reply_target(
    db: &PgPool,
    chat_id: Uuid,
    user_id: Uuid,
    message_id: Uuid,
) -> Result<Uuid, ApiError> {
    let found = sqlx::query_scalar::<_, Uuid>(
        r#"
        select m.id
        from public.messages m
        where m.id = $1
          and m.chat_id = $2
          and not exists (
              select 1
              from public.message_hidden_for_users hidden
              where hidden.message_id = m.id
                and hidden.user_id = $3
          )
        limit 1
        "#,
    )
    .bind(message_id)
    .bind(chat_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?;

    found.ok_or_else(|| ApiError::NotFound("reply target not found".to_string()))
}

async fn validate_forward_source(
    db: &PgPool,
    user_id: Uuid,
    message_id: Uuid,
) -> Result<ForwardSource, ApiError> {
    sqlx::query_as::<_, ForwardSource>(
        r#"
        select m.id, m.body
        from public.messages m
        join public.chat_members cm
            on cm.chat_id = m.chat_id
           and cm.user_id = $2
        where m.id = $1
          and m.deleted_at is null
          and not exists (
              select 1
              from public.message_hidden_for_users hidden
              where hidden.message_id = m.id
                and hidden.user_id = $2
          )
          and (
              cm.cleared_at is null
              or m.created_at > cm.cleared_at
          )
        limit 1
        "#,
    )
    .bind(message_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::NotFound("forward source not found".to_string()))
}

async fn hide_message_for_user(
    db: &PgPool,
    chat_id: Uuid,
    message_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let exists = sqlx::query_scalar::<_, bool>(
        r#"
        select exists(
            select 1
            from public.messages
            where id = $1
              and chat_id = $2
        )
        "#,
    )
    .bind(message_id)
    .bind(chat_id)
    .fetch_one(db)
    .await?;

    if !exists {
        return Err(ApiError::NotFound("message not found".to_string()));
    }

    sqlx::query(
        r#"
        insert into public.message_hidden_for_users (message_id, user_id, chat_id)
        values ($1, $2, $3)
        on conflict (message_id, user_id) do nothing
        "#,
    )
    .bind(message_id)
    .bind(user_id)
    .bind(chat_id)
    .execute(db)
    .await?;

    Ok(())
}

async fn delete_message_for_everyone(
    db: &PgPool,
    chat_id: Uuid,
    message_id: Uuid,
    user_id: Uuid,
) -> Result<(), ApiError> {
    let updated = sqlx::query(
        r#"
        update public.messages
        set deleted_at = coalesce(deleted_at, timezone('utc', now())),
            edited_at = null
        where id = $1
          and chat_id = $2
          and sender_id = $3
        "#,
    )
    .bind(message_id)
    .bind(chat_id)
    .bind(user_id)
    .execute(db)
    .await?
    .rows_affected();

    if updated == 0 {
        return Err(ApiError::NotFound("message not found".to_string()));
    }

    Ok(())
}

async fn clear_chat_for_self(db: &PgPool, chat_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        update public.chat_members
        set cleared_at = timezone('utc', now()),
            last_delivered_at = timezone('utc', now()),
            last_read_at = timezone('utc', now()),
            last_read_message_id = null
        where chat_id = $1
          and user_id = $2
        "#,
    )
    .bind(chat_id)
    .bind(user_id)
    .execute(db)
    .await?;

    Ok(())
}

async fn clear_chat_for_everyone(db: &PgPool, chat_id: Uuid) -> Result<(), ApiError> {
    let mut tx = db.begin().await?;

    sqlx::query(
        r#"
        delete from public.messages
        where chat_id = $1
        "#,
    )
    .bind(chat_id)
    .execute(tx.as_mut())
    .await?;

    sqlx::query(
        r#"
        update public.chat_members
        set cleared_at = null,
            last_delivered_at = null,
            last_read_at = null,
            last_read_message_id = null
        where chat_id = $1
        "#,
    )
    .bind(chat_id)
    .execute(tx.as_mut())
    .await?;

    tx.commit().await?;

    Ok(())
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
            peer.username as peer_username,
            peer.avatar_path as peer_avatar_path,
            peer.last_seen_at as peer_last_seen_at,
            case
                when lm.deleted_at is not null then 'Message deleted'
                else lm.body
            end as last_message,
            lm.created_at as last_message_at,
            coalesce(lm.created_at, c.created_at) as activity_at,
            0::bigint as unread_count,
            self_member.archived_at is not null as is_archived,
            self_member.pinned_at is not null as is_pinned,
            self_member.muted_until is not null
                and self_member.muted_until > timezone('utc', now()) as is_muted
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
            select m.body, m.created_at, m.deleted_at
            from public.messages m
            where m.chat_id = c.id
              and not exists (
                  select 1
                  from public.message_hidden_for_users hidden
                  where hidden.message_id = m.id
                    and hidden.user_id = $2
              )
              and (
                  self_member.cleared_at is null
                  or m.created_at > self_member.cleared_at
              )
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

    if let Some(peer) = peer_hint {
        return Ok(ChatSummary {
            id: row.id,
            peer: to_user_profile(peer),
            last_message: row.last_message,
            last_message_at: row.last_message_at,
            activity_at: row.activity_at,
            unread_count: 0,
            is_archived: row.is_archived,
            is_pinned: row.is_pinned,
            is_muted: row.is_muted,
        });
    }

    Ok(to_chat_summary(row))
}

async fn fetch_push_tokens_for_chat(
    db: &PgPool,
    chat_id: Uuid,
    sender_id: Uuid,
) -> Result<Vec<String>, ApiError> {
    let rows = sqlx::query_scalar::<_, String>(
        r#"
        select distinct ud.expo_push_token
        from public.user_devices ud
        join public.chat_members cm
            on cm.user_id = ud.user_id
        where cm.chat_id = $1
          and cm.user_id <> $2
          and (
              cm.muted_until is null
              or cm.muted_until <= timezone('utc', now())
          )
        "#,
    )
    .bind(chat_id)
    .bind(sender_id)
    .fetch_all(db)
    .await?;

    Ok(rows)
}

fn dispatch_push_notifications(
    http: reqwest::Client,
    sender_name: String,
    body: String,
    chat_id: Uuid,
    push_tokens: Vec<String>,
) {
    tokio::spawn(async move {
        let payload: Vec<_> = push_tokens
            .into_iter()
            .map(|token| {
                json!({
                    "to": token,
                    "sound": "default",
                    "title": sender_name,
                    "body": body,
                    "data": {
                        "chat_id": chat_id,
                    },
                })
            })
            .collect();

        let result = http
            .post("https://exp.host/--/api/v2/push/send")
            .header("accept", "application/json")
            .header("content-type", "application/json")
            .json(&payload)
            .send()
            .await;

        if let Err(error) = result {
            tracing::warn!(error = ?error, "failed to send expo push notification");
        }
    });
}

fn to_user_profile(record: ProfileRecord) -> UserProfile {
    UserProfile {
        id: record.id,
        phone_e164: canonical_phone(&record.phone_e164),
        username: record.username.and_then(non_empty_or_none),
        avatar_path: record.avatar_path.and_then(non_empty_or_none),
        last_seen_at: record.last_seen_at,
        is_online: is_online(record.last_seen_at),
    }
}

fn to_chat_summary(row: ChatSummaryRow) -> ChatSummary {
    ChatSummary {
        id: row.id,
        peer: UserProfile {
            id: row.peer_id,
            phone_e164: canonical_phone(&row.peer_phone_e164),
            username: row.peer_username.and_then(non_empty_or_none),
            avatar_path: row.peer_avatar_path.and_then(non_empty_or_none),
            last_seen_at: row.peer_last_seen_at,
            is_online: is_online(row.peer_last_seen_at),
        },
        last_message: row.last_message,
        last_message_at: row.last_message_at,
        activity_at: row.activity_at,
        unread_count: row.unread_count.max(0),
        is_archived: row.is_archived,
        is_pinned: row.is_pinned,
        is_muted: row.is_muted,
    }
}

fn to_message_record(row: MessageRecordRow) -> MessageRecord {
    MessageRecord {
        id: row.id,
        chat_id: row.chat_id,
        sender_id: row.sender_id,
        body: row.body,
        created_at: row.created_at,
        updated_at: row.updated_at,
        edited_at: row.edited_at,
        deleted_at: row.deleted_at,
        receipt_status: row.receipt_status.as_deref().and_then(parse_receipt_status),
        reply_to: zip_message_preview(
            row.reply_to_id,
            row.reply_to_sender_id,
            row.reply_to_body,
            row.reply_to_deleted_at,
        ),
        forwarded_from: zip_message_preview(
            row.forwarded_from_id,
            row.forwarded_from_sender_id,
            row.forwarded_from_body,
            row.forwarded_from_deleted_at,
        ),
    }
}

fn zip_message_preview(
    id: Option<Uuid>,
    sender_id: Option<Uuid>,
    body: Option<String>,
    deleted_at: Option<DateTime<Utc>>,
) -> Option<MessagePreview> {
    Some(MessagePreview {
        id: id?,
        sender_id: sender_id?,
        body: body?,
        is_deleted: deleted_at.is_some(),
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

fn normalize_username(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };

    let value = value.trim().to_lowercase();

    if value.is_empty() {
        return Ok(None);
    }

    let length = value.chars().count();
    if !(2..=32).contains(&length) {
        return Err(ApiError::BadRequest(
            "username must be between 2 and 32 characters".to_string(),
        ));
    }

    Ok(Some(value))
}

fn map_profile_update_error(error: sqlx::Error) -> ApiError {
    match error {
        sqlx::Error::Database(db_error) if db_error.code().as_deref() == Some("23505") => {
            ApiError::Status(
                StatusCode::CONFLICT,
                "username is already taken".to_string(),
            )
        }
        other => other.into(),
    }
}

fn normalize_avatar_path(user_id: Uuid, value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };

    let value = value.trim().to_string();

    if value.is_empty() {
        return Ok(None);
    }

    let expected_prefix = format!("{}/", user_id);
    if !value.starts_with(&expected_prefix) {
        return Err(ApiError::BadRequest(
            "avatar path must stay inside the current user's folder".to_string(),
        ));
    }

    Ok(Some(value))
}

fn normalize_push_token(value: String) -> Result<String, ApiError> {
    let value = value.trim().to_string();

    if value.is_empty() {
        return Err(ApiError::BadRequest(
            "expo push token must not be empty".to_string(),
        ));
    }

    Ok(value)
}

fn normalize_key_material(value: String, field_name: &str) -> Result<String, ApiError> {
    let value = value.trim().to_string();

    if value.is_empty() {
        return Err(ApiError::BadRequest(format!(
            "{field_name} must not be empty"
        )));
    }

    if value.len() > 16_384 {
        return Err(ApiError::BadRequest(format!(
            "{field_name} exceeds the maximum allowed length"
        )));
    }

    Ok(value)
}

fn normalize_one_time_prekeys(
    prekeys: Vec<OneTimePreKeyUpload>,
) -> Result<Vec<OneTimePreKeyUpload>, ApiError> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::with_capacity(prekeys.len());

    for prekey in prekeys {
        let public_key = normalize_key_material(prekey.public_key, "one_time_prekeys.public_key")?;
        if !seen.insert(prekey.key_id) {
            return Err(ApiError::BadRequest(
                "one_time_prekeys contains duplicate key_id values".to_string(),
            ));
        }

        normalized.push(OneTimePreKeyUpload {
            key_id: prekey.key_id,
            public_key,
        });
    }

    Ok(normalized)
}

fn normalize_message_type(value: i16) -> Result<i16, ApiError> {
    match value {
        1 | 3 => Ok(value),
        _ => Err(ApiError::BadRequest(
            "message_type must be 1 or 3".to_string(),
        )),
    }
}

fn normalize_platform(value: String) -> Result<String, ApiError> {
    let value = value.trim().to_lowercase();

    match value.as_str() {
        "ios" | "android" | "web" => Ok(value),
        _ => Err(ApiError::BadRequest("invalid platform".to_string())),
    }
}

fn non_empty_or_none(value: String) -> Option<String> {
    let value = value.trim().to_string();
    if value.is_empty() { None } else { Some(value) }
}

fn to_pending_message_response(row: PendingMessageRow) -> PendingMessageResponse {
    PendingMessageResponse {
        id: row.id,
        sender_user_id: row.sender_user_id,
        sender_device_id: row.sender_device_id,
        receiver_device_id: row.receiver_device_id,
        message_type: row.message_type,
        ciphertext: row.ciphertext,
        client_message_id: row.client_message_id,
        created_at: row.created_at,
        delivered_at: row.delivered_at,
    }
}

fn parse_receipt_status(value: &str) -> Option<ReceiptStatus> {
    match value {
        "sent" => Some(ReceiptStatus::Sent),
        "delivered" => Some(ReceiptStatus::Delivered),
        "seen" => Some(ReceiptStatus::Seen),
        _ => None,
    }
}

fn is_online(last_seen_at: Option<DateTime<Utc>>) -> bool {
    last_seen_at
        .map(|value| value >= Utc::now() - Duration::seconds(ONLINE_WINDOW_SECONDS))
        .unwrap_or(false)
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

fn normalize_contact_phones(phones: Vec<String>) -> Result<Vec<String>, ApiError> {
    let mut normalized = BTreeSet::new();

    for phone in phones.into_iter().take(500) {
        let digits = phone_digits(&phone)?;
        normalized.insert(digits);
    }

    Ok(normalized.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::{
        ReceiptStatus, canonical_phone, dm_key, is_online, normalize_avatar_path,
        normalize_message_body, normalize_platform, normalize_push_token, normalize_username,
        parse_receipt_status, phone_digits,
    };
    use chrono::{Duration, Utc};
    use uuid::{Uuid, uuid};

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

    #[test]
    fn validates_username_length() {
        assert_eq!(
            normalize_username(Some("  Aa  ".to_string())).unwrap(),
            Some("aa".to_string())
        );
        assert!(normalize_username(Some("x".to_string())).is_err());
    }

    #[test]
    fn validates_avatar_path_prefix() {
        let user_id = Uuid::nil();
        assert!(normalize_avatar_path(user_id, Some("other/file.png".to_string())).is_err());
        assert_eq!(
            normalize_avatar_path(user_id, Some(format!("{user_id}/avatar.png"))).unwrap(),
            Some(format!("{user_id}/avatar.png"))
        );
    }

    #[test]
    fn parses_receipt_status_values() {
        assert!(matches!(
            parse_receipt_status("sent"),
            Some(ReceiptStatus::Sent)
        ));
        assert!(matches!(
            parse_receipt_status("delivered"),
            Some(ReceiptStatus::Delivered)
        ));
        assert!(matches!(
            parse_receipt_status("seen"),
            Some(ReceiptStatus::Seen)
        ));
    }

    #[test]
    fn validates_platform_and_push_token() {
        assert_eq!(normalize_platform("iOS".to_string()).unwrap(), "ios");
        assert!(normalize_platform("desktop".to_string()).is_err());
        assert!(normalize_push_token("token".to_string()).is_ok());
    }

    #[test]
    fn online_window_uses_recent_last_seen() {
        assert!(is_online(Some(Utc::now() - Duration::seconds(30))));
        assert!(!is_online(Some(Utc::now() - Duration::seconds(180))));
    }
}

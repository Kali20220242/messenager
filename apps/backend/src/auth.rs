use axum::{
    extract::State,
    http::{HeaderMap, StatusCode, header},
    middleware::Next,
    response::Response,
};
use serde::Deserialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::ApiError, state::AppState};

#[derive(Clone, Debug)]
pub struct CurrentUser {
    pub id: Uuid,
    pub phone_e164: Option<String>,
}

#[derive(Deserialize)]
struct SupabaseUser {
    id: Uuid,
    phone: Option<String>,
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let token = bearer_token(request.headers())?;
    let user = fetch_current_user(&state, token).await?;
    sync_profile(&state.db, &user).await?;
    touch_presence(&state.db, user.id).await?;
    request.extensions_mut().insert(user);
    Ok(next.run(request).await)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    let value = headers
        .get(header::AUTHORIZATION)
        .ok_or_else(|| ApiError::Unauthorized("missing authorization header".to_string()))?;
    let value = value
        .to_str()
        .map_err(|_| ApiError::Unauthorized("invalid authorization header".to_string()))?;

    value
        .strip_prefix("Bearer ")
        .ok_or_else(|| ApiError::Unauthorized("expected bearer token".to_string()))
}

async fn fetch_current_user(state: &AppState, token: &str) -> Result<CurrentUser, ApiError> {
    let url = format!(
        "{}/auth/v1/user",
        state.config.supabase_url.trim_end_matches('/')
    );

    let response = state
        .http
        .get(url)
        .header("apikey", &state.config.supabase_auth_key)
        .header(header::AUTHORIZATION, format!("Bearer {token}"))
        .send()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    if response.status() == reqwest::StatusCode::UNAUTHORIZED
        || response.status() == reqwest::StatusCode::FORBIDDEN
    {
        return Err(ApiError::Unauthorized("invalid bearer token".to_string()));
    }

    if response.status() != reqwest::StatusCode::OK {
        return Err(ApiError::Status(
            StatusCode::BAD_GATEWAY,
            "supabase auth lookup failed".to_string(),
        ));
    }

    let user = response
        .json::<SupabaseUser>()
        .await
        .map_err(|error| ApiError::Internal(error.into()))?;

    Ok(CurrentUser {
        id: user.id,
        phone_e164: user.phone.as_deref().map(canonical_phone),
    })
}

async fn sync_profile(db: &PgPool, user: &CurrentUser) -> Result<(), ApiError> {
    let Some(phone_e164) = user.phone_e164.as_deref() else {
        return Ok(());
    };
    let phone_e164 = canonical_phone(phone_e164);

    sqlx::query(
        r#"
        insert into public.profiles (id, phone_e164, display_name)
        values ($1, $2, null)
        on conflict (id) do update
        set phone_e164 = excluded.phone_e164
        "#,
    )
    .bind(user.id)
    .bind(phone_e164)
    .execute(db)
    .await?;

    Ok(())
}

async fn touch_presence(db: &PgPool, user_id: Uuid) -> Result<(), ApiError> {
    sqlx::query(
        r#"
        update public.profiles
        set last_seen_at = timezone('utc', now())
        where id = $1
        "#,
    )
    .bind(user_id)
    .execute(db)
    .await?;

    Ok(())
}

pub(crate) fn canonical_phone(value: &str) -> String {
    let digits: String = value.chars().filter(|char| char.is_ascii_digit()).collect();

    if digits.is_empty() {
        value.trim().to_string()
    } else {
        format!("+{digits}")
    }
}

pub async fn rate_limit_search(
    State(state): State<AppState>,
    request: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let key = search_rate_limit_key(request.headers());

    if let Some(retry_after_seconds) = state.search_rate_limiter.check(&key).await {
        return Err(ApiError::Status(
            StatusCode::TOO_MANY_REQUESTS,
            format!("search rate limit exceeded; retry in {retry_after_seconds}s"),
        ));
    }

    Ok(next.run(request).await)
}

fn search_rate_limit_key(headers: &HeaderMap) -> String {
    if let Ok(token) = bearer_token(headers) {
        return format!("bearer:{token}");
    }

    if let Some(value) = header_value(headers, "x-forwarded-for") {
        let forwarded = value
            .split(',')
            .next()
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .unwrap_or("unknown");
        return format!("ip:{forwarded}");
    }

    if let Some(value) = header_value(headers, "x-real-ip") {
        return format!("ip:{value}");
    }

    "unknown".to_string()
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToOwned::to_owned)
}

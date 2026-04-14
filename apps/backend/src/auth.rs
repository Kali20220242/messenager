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
    let url = format!("{}/auth/v1/user", state.config.supabase_url.trim_end_matches('/'));

    let response = state
        .http
        .get(url)
        .header("apikey", &state.config.supabase_publishable_key)
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
        phone_e164: user.phone,
    })
}

async fn sync_profile(db: &PgPool, user: &CurrentUser) -> Result<(), ApiError> {
    let Some(phone_e164) = user.phone_e164.as_deref() else {
        return Ok(());
    };
    let phone_e164 = canonical_phone(phone_e164);

    sqlx::query(
        r#"
        insert into public.profiles (id, username, phone_e164, display_name)
        values ($1, $2, $2, null)
        on conflict (id) do update
        set username = excluded.username,
            phone_e164 = excluded.phone_e164
        "#,
    )
    .bind(user.id)
    .bind(phone_e164)
    .execute(db)
    .await?;

    Ok(())
}

fn canonical_phone(value: &str) -> String {
    let digits: String = value.chars().filter(|char| char.is_ascii_digit()).collect();

    if digits.is_empty() {
        value.trim().to_string()
    } else {
        format!("+{digits}")
    }
}

mod config;

use std::sync::Arc;

use anyhow::Result;
use axum::{Json, Router, extract::State, http::StatusCode, response::IntoResponse, routing::get};
use config::AppConfig;
use serde::Serialize;
use sqlx::{PgPool, postgres::PgPoolOptions};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

#[derive(Clone)]
struct AppState {
    config: Arc<AppConfig>,
    db: PgPool,
}

#[derive(Serialize)]
struct HealthResponse<'a> {
    service: &'a str,
    status: &'a str,
    supabase_url: String,
}

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Arc::new(AppConfig::from_env()?);
    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.supabase_db_url)
        .await?;

    let app = Router::new()
        .route("/health", get(health))
        .route("/ready", get(ready))
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(AppState {
            config: Arc::clone(&config),
            db,
        });

    let listener = tokio::net::TcpListener::bind(config.address).await?;
    info!("backend listening on {}", config.address);
    axum::serve(listener, app).await?;
    Ok(())
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

fn init_tracing() {
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "messenger_backend=debug,tower_http=info".into()),
        )
        .compact()
        .init();
}

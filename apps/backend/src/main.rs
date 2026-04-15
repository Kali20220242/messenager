mod auth;
mod config;
mod error;
mod handlers;
mod state;

use std::{sync::Arc, time::Duration};

use anyhow::Result;
use config::AppConfig;
use reqwest::Client;
use sqlx::postgres::PgPoolOptions;
use state::{AppState, SearchRateLimiter};
use tower_http::{cors::CorsLayer, trace::TraceLayer};
use tracing::info;

#[tokio::main]
async fn main() -> Result<()> {
    dotenvy::dotenv().ok();
    init_tracing();

    let config = Arc::new(AppConfig::from_env()?);
    let db = PgPoolOptions::new()
        .max_connections(5)
        .connect(&config.supabase_db_url)
        .await?;

    let state = AppState {
        config: Arc::clone(&config),
        db,
        http: Client::new(),
        search_rate_limiter: SearchRateLimiter::new(25, Duration::from_secs(60)),
    };

    let app = handlers::router(state)
        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http());

    let listener = tokio::net::TcpListener::bind(config.address).await?;
    info!("backend listening on {}", config.address);
    axum::serve(listener, app).await?;

    Ok(())
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

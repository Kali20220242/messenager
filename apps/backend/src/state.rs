use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use reqwest::Client;
use sqlx::PgPool;
use tokio::sync::Mutex;

use crate::config::AppConfig;

#[derive(Clone)]
pub struct AppState {
    pub config: Arc<AppConfig>,
    pub db: PgPool,
    pub http: Client,
    pub search_rate_limiter: SearchRateLimiter,
}

#[derive(Clone)]
pub struct SearchRateLimiter {
    entries: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
    limit: usize,
    window: Duration,
}

impl SearchRateLimiter {
    pub fn new(limit: usize, window: Duration) -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            limit,
            window,
        }
    }

    pub async fn check(&self, key: &str) -> Option<u64> {
        let now = Instant::now();
        let mut entries = self.entries.lock().await;

        if entries.len() > 1024 {
            entries.retain(|_, timestamps| {
                prune_timestamps(timestamps, now, self.window);
                !timestamps.is_empty()
            });
        }

        let timestamps = entries.entry(key.to_string()).or_default();
        prune_timestamps(timestamps, now, self.window);

        if timestamps.len() >= self.limit {
            let retry_after_seconds = timestamps
                .front()
                .map(|first_seen| {
                    self.window
                        .saturating_sub(now.duration_since(*first_seen))
                        .as_secs()
                        .max(1)
                })
                .unwrap_or(1);

            return Some(retry_after_seconds);
        }

        timestamps.push_back(now);
        None
    }
}

fn prune_timestamps(timestamps: &mut VecDeque<Instant>, now: Instant, window: Duration) {
    while timestamps
        .front()
        .is_some_and(|timestamp| now.duration_since(*timestamp) >= window)
    {
        timestamps.pop_front();
    }
}

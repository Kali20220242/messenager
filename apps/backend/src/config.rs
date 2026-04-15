use std::{env, net::SocketAddr};

use anyhow::{Context, Result};

#[derive(Clone, Debug)]
pub struct AppConfig {
    pub address: SocketAddr,
    pub supabase_url: String,
    pub supabase_db_url: String,
    pub supabase_auth_key: String,
}

impl AppConfig {
    pub fn from_env() -> Result<Self> {
        let host = env::var("API_HOST").unwrap_or_else(|_| "127.0.0.1".to_string());
        let port = env::var("API_PORT")
            .unwrap_or_else(|_| "8080".to_string())
            .parse::<u16>()
            .context("API_PORT must be a valid integer")?;
        let supabase_url =
            env::var("SUPABASE_URL").context("SUPABASE_URL must be present in the environment")?;
        let supabase_db_url = env::var("SUPABASE_DB_URL")
            .context("SUPABASE_DB_URL must be present in the environment")?;
        let supabase_auth_key = env::var("SUPABASE_ANON_KEY")
            .or_else(|_| env::var("SUPABASE_PUBLISHABLE_KEY"))
            .context(
                "SUPABASE_ANON_KEY or SUPABASE_PUBLISHABLE_KEY must be present in the environment",
            )?;

        let address = format!("{host}:{port}")
            .parse::<SocketAddr>()
            .context("API_HOST/API_PORT produced an invalid socket address")?;

        Ok(Self {
            address,
            supabase_url,
            supabase_db_url,
            supabase_auth_key,
        })
    }
}

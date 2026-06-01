//! CORS policy, configured from the environment so allowed domains can change
//! without a rebuild.
//!
//! - `CORS_ALLOWED_ORIGINS` — comma-separated list of exact origins, e.g.
//!   `"https://vault.example.com,https://www.example.com"`.
//! - `CORS_ALLOW_LOCAL` (default `true`) — additionally permit localhost/LAN
//!   origins for development. Set to `false` in production to allow only the
//!   explicit list above.

use actix_cors::Cors;

/// Parsed CORS settings, read once at startup and reused to build a fresh
/// [`Cors`] per HTTP worker.
#[derive(Clone)]
pub struct CorsConfig {
    allowed_origins: Vec<String>,
    allow_local: bool,
}

impl CorsConfig {
    /// Read the policy from the environment.
    pub fn from_env() -> Self {
        let allowed_origins = std::env::var("CORS_ALLOWED_ORIGINS")
            .unwrap_or_default()
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect();

        let allow_local = std::env::var("CORS_ALLOW_LOCAL")
            .map(|v| !matches!(v.trim().to_ascii_lowercase().as_str(), "false" | "0" | "no"))
            .unwrap_or(true);

        Self { allowed_origins, allow_local }
    }

    /// Log a one-line summary of the active policy.
    pub fn log(&self) {
        println!(
            "🔒 CORS: {} explicit origin(s){}",
            self.allowed_origins.len(),
            if self.allow_local { " + localhost/LAN (dev)" } else { "" }
        );
    }

    /// Build an actix [`Cors`] middleware from this policy. Called once per
    /// worker, so the origin list is cloned into the matcher closure.
    pub fn build(&self) -> Cors {
        let allowed_origins = self.allowed_origins.clone();
        let allow_local = self.allow_local;

        Cors::default()
            .allowed_origin_fn(move |origin, _req_head| {
                let o = origin.as_bytes();
                if allow_local
                    && (o.starts_with(b"http://localhost:")
                        || o.starts_with(b"http://127.0.0.1:")
                        || o.starts_with(b"http://192.168.")
                        || o.starts_with(b"http://10."))
                {
                    return true;
                }
                allowed_origins.iter().any(|allowed| allowed.as_bytes() == o)
            })
            .allowed_methods(vec!["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"])
            // Origin allowlist (above) + JWT auth are the security boundary here;
            // request headers are not. Allow any header so custom client headers
            // (e.g. x-openclaw-session-key, last-event-id) don't trip preflight 400s.
            .allow_any_header()
            .max_age(3600)
    }
}

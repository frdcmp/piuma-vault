// In-process fixed-window rate limiter.
//
// Redis is intentionally commented out in docker-compose at this point, so we
// run the limiter inside the actix process. At single-server scale this is
// fine: state is shared across worker threads via web::Data + moka, and resets
// fully on restart (a property we actually want for an admin who has locked
// themselves out — restart the API and try again).
//
// Each call to `check()` increments the bucket for the (scope, identifier)
// key. The bucket counts requests inside a sliding-on-restart fixed window;
// once the window elapses the bucket resets. moka's TTL evicts unused buckets
// so memory stays bounded.

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use actix_web::HttpRequest;
use moka::future::Cache;

#[derive(Debug)]
struct Bucket {
    window_started_at: Instant,
    count: u32,
}

#[derive(Clone)]
pub struct RateLimiter {
    cache: Cache<String, Arc<Mutex<Bucket>>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self::new()
    }
}

impl RateLimiter {
    pub fn new() -> Self {
        Self {
            cache: Cache::builder()
                .max_capacity(50_000)
                // Long enough to outlive any window we use below; moka evicts
                // idle buckets so memory stays bounded.
                .time_to_live(Duration::from_secs(3600 * 6))
                .build(),
        }
    }

    /// Increment the bucket for (scope, identifier). Returns Ok(()) if the
    /// request is allowed, or Err((retry_after_secs)) if over the limit.
    pub async fn check(
        &self,
        scope: &str,
        identifier: &str,
        max: u32,
        window: Duration,
    ) -> Result<(), u64> {
        let key = format!("{}:{}", scope, identifier);
        let bucket = self
            .cache
            .get_with(key, async {
                Arc::new(Mutex::new(Bucket {
                    window_started_at: Instant::now(),
                    count: 0,
                }))
            })
            .await;
        let mut b = bucket.lock().expect("rate-limit mutex poisoned");
        if b.window_started_at.elapsed() >= window {
            b.window_started_at = Instant::now();
            b.count = 0;
        }
        b.count = b.count.saturating_add(1);
        if b.count > max {
            let remaining = window
                .saturating_sub(b.window_started_at.elapsed())
                .as_secs()
                .max(1);
            return Err(remaining);
        }
        Ok(())
    }
}

/// Extract a stable per-client identifier from the request.
///
/// Resolution order:
///   1. `CF-Connecting-IP` — set by Cloudflare to the real client IP. This is
///      authoritative for this deployment because the public edge is CF and
///      requests reach origin from CF IPs only.
///   2. The first IP in `X-Forwarded-For` / `X-Real-IP` via actix's
///      `realip_remote_addr` (nginx populates these too).
///   3. Socket peer address.
///
/// Returns "unknown" if nothing identifies the client (misconfigured edge —
/// log it but don't crash auth).
pub fn client_ip(req: &HttpRequest) -> String {
    if let Some(v) = req.headers().get("CF-Connecting-IP") {
        if let Ok(s) = v.to_str() {
            let trimmed = s.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
    }
    let info = req.connection_info();
    if let Some(ip) = info.realip_remote_addr() {
        return ip.to_string();
    }
    "unknown".to_string()
}

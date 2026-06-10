//! Idle screen-lock config + unlock verification.
//!
//! The lock is a "soft" blocker for an already-authenticated session: it stops a
//! passer-by from reading/using an unattended screen. Config lives in the global
//! `app_settings` table (single-tenant). The PIN is stored only as an argon2 hash
//! — the same tuned Argon2id used for passwords — and verified server-side so it
//! can't be read or brute-forced from the client (the verify path is rate-limited).

use actix_web::{web, HttpRequest, HttpResponse, Responder};
use argon2::password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString};

use super::models::{ScreenLockConfig, UpdateScreenLock, VerifyPinRequest};
use super::store;
use crate::apps::auth::handlers::argon2_instance_pub;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::auth::rate_limit::{client_ip, RateLimiter};
use crate::db::db::DbPool;

const DEFAULT_TIMEOUT_SECONDS: i64 = 300;
const MIN_TIMEOUT_SECONDS: i64 = 30;
const MAX_TIMEOUT_SECONDS: i64 = 86_400;

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": "admin_access required" }))
}

/// Build the current screen-lock config view (PIN masked behind `pin_set`).
async fn current_config(pool: &DbPool) -> ScreenLockConfig {
    let enabled = store::get(pool, store::SCREEN_LOCK_ENABLED)
        .await
        .map(|v| v == "true")
        .unwrap_or(false);
    let timeout_seconds = store::get(pool, store::SCREEN_LOCK_TIMEOUT_SECONDS)
        .await
        .and_then(|v| v.parse::<i64>().ok())
        .unwrap_or(DEFAULT_TIMEOUT_SECONDS);
    let pin_set = store::get(pool, store::SCREEN_LOCK_PIN_HASH).await.is_some();
    ScreenLockConfig {
        enabled,
        timeout_seconds,
        pin_set,
    }
}

/// GET /admin/settings/screen-lock — current config (PIN never returned).
pub async fn get_screen_lock(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    HttpResponse::Ok().json(current_config(pool.get_ref()).await)
}

/// PUT /admin/settings/screen-lock — partial update of the lock config.
///
/// `pin` (when present) must be exactly 6 digits and is stored as an argon2 hash.
/// Enabling the lock requires a PIN to be set (either already stored or in this
/// request). `timeout_seconds` is clamped to [30, 86400].
pub async fn update_screen_lock(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<UpdateScreenLock>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let body = body.into_inner();

    // Validate + persist a new PIN first, so the "enable requires a PIN" check
    // below can see it.
    if let Some(pin) = body.pin.as_ref() {
        let pin = pin.trim();
        if pin.len() != 6 || !pin.chars().all(|c| c.is_ascii_digit()) {
            return HttpResponse::BadRequest()
                .json(serde_json::json!({ "error": "PIN must be exactly 6 digits" }));
        }
        let salt = SaltString::generate(&mut OsRng);
        let hash = match argon2_instance_pub().hash_password(pin.as_bytes(), &salt) {
            Ok(h) => h.to_string(),
            Err(e) => {
                log::error!("Failed to hash screen-lock PIN: {e}");
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({ "error": "Failed to set PIN" }));
            }
        };
        if let Err(e) = store::set(pool, store::SCREEN_LOCK_PIN_HASH, &hash).await {
            log::error!("Failed to save screen-lock PIN: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Failed to set PIN" }));
        }
    }

    if let Some(enabled) = body.enabled {
        if enabled {
            let pin_set = store::get(pool, store::SCREEN_LOCK_PIN_HASH).await.is_some();
            if !pin_set {
                return HttpResponse::BadRequest()
                    .json(serde_json::json!({ "error": "Set a PIN before enabling the screen lock" }));
            }
        }
        if let Err(e) = store::set(pool, store::SCREEN_LOCK_ENABLED, if enabled { "true" } else { "false" }).await {
            log::error!("Failed to save screen-lock enabled flag: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Failed to save settings" }));
        }
    }

    if let Some(timeout) = body.timeout_seconds {
        let clamped = timeout.clamp(MIN_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS);
        if let Err(e) = store::set(pool, store::SCREEN_LOCK_TIMEOUT_SECONDS, &clamped.to_string()).await {
            log::error!("Failed to save screen-lock timeout: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "Failed to save settings" }));
        }
    }

    HttpResponse::Ok().json(current_config(pool).await)
}

/// POST /admin/settings/screen-lock/verify — verify a PIN to unlock.
///
/// Open to any authenticated user (it's the unlock path, not an admin action),
/// but rate-limited per client IP to bound brute force.
pub async fn verify_screen_lock(
    req: HttpRequest,
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    body: web::Json<VerifyPinRequest>,
) -> impl Responder {
    let ip = client_ip(&req);
    if let Err(retry_after) = limiter
        .check("screen_lock_verify", &ip, 10, std::time::Duration::from_secs(300))
        .await
    {
        return HttpResponse::TooManyRequests()
            .insert_header(("Retry-After", retry_after.to_string()))
            .json(serde_json::json!({
                "error": "too_many_requests",
                "retry_after_seconds": retry_after,
            }));
    }

    let stored = match store::get(pool.get_ref(), store::SCREEN_LOCK_PIN_HASH).await {
        Some(h) => h,
        None => return HttpResponse::Ok().json(serde_json::json!({ "ok": false })),
    };
    let ok = PasswordHash::new(&stored)
        .map(|parsed| {
            argon2_instance_pub()
                .verify_password(body.pin.trim().as_bytes(), &parsed)
                .is_ok()
        })
        .unwrap_or(false);
    HttpResponse::Ok().json(serde_json::json!({ "ok": ok }))
}

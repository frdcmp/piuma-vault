// HTTP handlers for the OTP / TOTP feature.
//
// Endpoints (all under /auth/otp/* unless noted):
//   POST /auth/otp/setup           — issue secret + otpauth URI (requires login)
//   POST /auth/otp/verify-setup    — confirm code, enable OTP, return backup codes
//   POST /auth/otp/disable         — turn OTP off (requires password + code)
//   POST /auth/login/otp           — second step of login: verify code or backup
//   GET  /auth/devices             — list trusted devices for current user
//   DELETE /auth/devices/{id}      — revoke one
//
// The handlers here intentionally pull from `handlers.rs` for shared helpers
// like `fetch_user_full`, `argon2_instance`, and `generate_tokens`.

use actix_web::{web, HttpRequest, HttpResponse, Responder};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
};
use serde::Deserialize;

use crate::db::db::DbPool;
use super::models::AuthenticatedUser;
use super::handlers::{argon2_instance_pub, fetch_user_full_pub, generate_tokens_pub};
use super::rate_limit::{client_ip, RateLimiter};
use super::otp;

// The label shown in authenticator apps for 2FA. Derived from `SITE_URL` (the
// site's canonical identity), falling back to a default. A full URL is trimmed
// to a clean host label (e.g. `https://vault.example.com/` → `vault.example.com`).
fn otp_issuer() -> String {
    let raw = std::env::var("SITE_URL").unwrap_or_else(|_| "Piuma Vault".to_string());
    let label = raw
        .trim()
        .trim_start_matches("https://")
        .trim_start_matches("http://")
        .trim_end_matches('/')
        .split('/')
        .next()
        .unwrap_or("")
        .trim();
    if label.is_empty() {
        "Piuma Vault".to_string()
    } else {
        label.to_string()
    }
}

// ── shared rate-limit helper (mirror of the one in handlers.rs) ──
async fn enforce(
    limiter: &RateLimiter,
    scope: &str,
    identifier: &str,
    max: u32,
    window_secs: u64,
) -> Result<(), HttpResponse> {
    if identifier.is_empty() {
        return Ok(());
    }
    match limiter
        .check(scope, identifier, max, std::time::Duration::from_secs(window_secs))
        .await
    {
        Ok(()) => Ok(()),
        Err(retry_after) => Err(HttpResponse::TooManyRequests()
            .insert_header(("Retry-After", retry_after.to_string()))
            .json(serde_json::json!({
                "error": "too_many_requests",
                "retry_after_seconds": retry_after,
            }))),
    }
}

// ── POST /auth/otp/setup ──
//
// Generates a fresh TOTP secret and returns it along with the otpauth URI so
// the frontend can render a QR. The secret is staged on the user row but
// `otp_enabled` stays false until the user successfully confirms a code.

pub async fn otp_setup(
    pool: web::Data<DbPool>,
    user: AuthenticatedUser,
) -> impl Responder {
    let secret = otp::generate_secret_b32();
    let issuer = otp_issuer();
    let uri = otp::build_otpauth_uri(&secret, &user.email, &issuer);

    if let Err(e) = sqlx::query(
        "UPDATE db_users SET otp_secret = $1, otp_enabled = FALSE, otp_enrolled_at = NULL WHERE id = $2"
    )
    .bind(&secret).bind(&user.user_id)
    .execute(pool.get_ref()).await
    {
        log::error!("otp setup persist: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    HttpResponse::Ok().json(serde_json::json!({
        "secret": secret,
        "otpauth_uri": uri,
        "issuer": issuer,
    }))
}

#[derive(Deserialize)]
pub struct VerifySetupRequest {
    pub code: String,
}

// ── POST /auth/otp/verify-setup ──
//
// Confirms the user has scanned the QR and can produce a valid code. Flips
// otp_enabled=true and generates 8 backup codes which are returned exactly
// once.

pub async fn otp_verify_setup(
    pool: web::Data<DbPool>,
    user: AuthenticatedUser,
    item: web::Json<VerifySetupRequest>,
) -> impl Responder {
    let row: Result<(Option<String>, bool), _> = sqlx::query_as(
        "SELECT otp_secret, otp_enabled FROM db_users WHERE id = $1"
    )
    .bind(&user.user_id)
    .fetch_one(pool.get_ref()).await;

    let (secret, already_enabled) = match row {
        Ok((Some(s), e)) => (s, e),
        Ok((None, _)) => return HttpResponse::BadRequest().json("Run /otp/setup first"),
        Err(e) => {
            log::error!("otp verify-setup fetch: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    if already_enabled {
        return HttpResponse::BadRequest().json("OTP already enabled");
    }

    if !otp::verify_totp(&secret, &item.code) {
        return HttpResponse::Unauthorized().json("Invalid code");
    }

    // Generate backup codes, hash with argon2, persist.
    let codes = otp::generate_backup_codes();
    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(e) => { log::error!("otp tx begin: {}", e); return HttpResponse::InternalServerError().finish(); }
    };

    if let Err(e) = sqlx::query(
        "UPDATE db_users SET otp_enabled = TRUE, otp_enrolled_at = NOW() WHERE id = $1"
    ).bind(&user.user_id).execute(&mut *tx).await {
        log::error!("otp enable: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    if let Err(e) = sqlx::query("DELETE FROM db_otp_backup_codes WHERE user_id = $1")
        .bind(&user.user_id).execute(&mut *tx).await
    {
        log::error!("otp backup wipe: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    for c in &codes {
        let normalized = otp::normalize_backup_code(c);
        let salt = SaltString::generate(&mut OsRng);
        let hash = match argon2_instance_pub().hash_password(normalized.as_bytes(), &salt) {
            Ok(h) => h.to_string(),
            Err(e) => { log::error!("hash backup: {}", e); return HttpResponse::InternalServerError().finish(); }
        };
        if let Err(e) = sqlx::query(
            "INSERT INTO db_otp_backup_codes (user_id, code_hash) VALUES ($1, $2)"
        ).bind(&user.user_id).bind(&hash).execute(&mut *tx).await
        {
            log::error!("backup insert: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    }

    if let Err(e) = tx.commit().await {
        log::error!("otp tx commit: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    HttpResponse::Ok().json(serde_json::json!({
        "enabled": true,
        "backup_codes": codes,
    }))
}

#[derive(Deserialize)]
pub struct DisableRequest {
    pub password: String,
    pub code: String,
}

// ── POST /auth/otp/disable ──

pub async fn otp_disable(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    user: AuthenticatedUser,
    item: web::Json<DisableRequest>,
) -> impl Responder {
    let ip = client_ip(&req);
    if let Err(r) = enforce(&limiter, "otp_disable_ip", &ip, 5, 900).await { return r; }
    if let Err(r) = enforce(&limiter, "otp_disable_user", &user.user_id, 5, 900).await { return r; }

    let row = match fetch_user_full_pub(pool.get_ref(), "u.id = $1", &user.user_id).await {
        Ok(Some(u)) => u,
        _ => return HttpResponse::Unauthorized().finish(),
    };

    let parsed = match PasswordHash::new(&row.password_hash) {
        Ok(h) => h,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    if argon2_instance_pub().verify_password(item.password.as_bytes(), &parsed).is_err() {
        return HttpResponse::Unauthorized().json("Invalid credentials");
    }
    let secret = match row.otp_secret {
        Some(s) => s,
        None => return HttpResponse::BadRequest().json("OTP not enabled"),
    };
    if !otp::verify_totp(&secret, &item.code) {
        return HttpResponse::Unauthorized().json("Invalid code");
    }

    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(_) => return HttpResponse::InternalServerError().finish(),
    };
    let _ = sqlx::query(
        "UPDATE db_users SET otp_enabled = FALSE, otp_secret = NULL, otp_enrolled_at = NULL WHERE id = $1"
    ).bind(&user.user_id).execute(&mut *tx).await;
    let _ = sqlx::query("DELETE FROM db_otp_backup_codes WHERE user_id = $1")
        .bind(&user.user_id).execute(&mut *tx).await;
    let _ = sqlx::query("DELETE FROM db_trusted_devices WHERE user_id = $1")
        .bind(&user.user_id).execute(&mut *tx).await;
    if let Err(e) = tx.commit().await {
        log::error!("otp disable commit: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    HttpResponse::Ok().json("OTP disabled")
}

#[derive(Deserialize)]
pub struct LoginOtpRequest {
    pub otp_session: String,
    pub code: String,
    #[serde(default)]
    pub trust_device: bool,
    #[serde(default)]
    pub device_label: Option<String>,
}

// ── POST /auth/login/otp ──
//
// Second step of login. The `otp_session` JWT comes from the first step's
// response. We accept either a 6-digit TOTP code or a backup code.

pub async fn login_otp(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    item: web::Json<LoginOtpRequest>,
) -> impl Responder {
    let ip = client_ip(&req);
    if let Err(r) = enforce(&limiter, "login_otp_ip", &ip, 10, 900).await { return r; }

    let user_id = match otp::verify_otp_session(&item.otp_session) {
        Ok(id) => id,
        Err(msg) => return HttpResponse::Unauthorized().json(msg),
    };

    if let Err(r) = enforce(&limiter, "login_otp_user", &user_id, 5, 900).await { return r; }

    let user = match fetch_user_full_pub(pool.get_ref(), "u.id = $1", &user_id).await {
        Ok(Some(u)) => u,
        _ => return HttpResponse::Unauthorized().finish(),
    };
    let secret = match &user.otp_secret {
        Some(s) => s.clone(),
        None => return HttpResponse::Unauthorized().json("OTP not enabled"),
    };

    let trimmed = item.code.trim();
    let looks_like_totp = trimmed.len() == 6 && trimmed.chars().all(|c| c.is_ascii_digit());
    let mut ok = false;

    if looks_like_totp {
        ok = otp::verify_totp(&secret, trimmed);
    }

    if !ok {
        // Try as a backup code (case-insensitive, dashes stripped).
        let normalized = otp::normalize_backup_code(trimmed);
        if normalized.len() == 10 {
            let rows: Vec<(String,)> = sqlx::query_as(
                "SELECT code_hash FROM db_otp_backup_codes
                 WHERE user_id = $1 AND used_at IS NULL"
            ).bind(&user.id).fetch_all(pool.get_ref()).await.unwrap_or_default();
            for (hash,) in rows {
                if let Ok(parsed) = PasswordHash::new(&hash) {
                    if argon2_instance_pub().verify_password(normalized.as_bytes(), &parsed).is_ok() {
                        ok = true;
                        let _ = sqlx::query(
                            "UPDATE db_otp_backup_codes SET used_at = NOW()
                             WHERE user_id = $1 AND code_hash = $2"
                        ).bind(&user.id).bind(&hash).execute(pool.get_ref()).await;
                        break;
                    }
                }
            }
        }
    }

    if !ok {
        return HttpResponse::Unauthorized().json("Invalid code");
    }

    let (access_token, refresh_token) = match generate_tokens_pub(&user) {
        Ok(t) => t,
        Err(e) => return HttpResponse::InternalServerError().json(e),
    };

    // Optionally mint a trusted-device token. The user controls this via the
    // `trust_device` checkbox.
    let trusted_device_token = if item.trust_device {
        let device = otp::issue_trusted_device();
        let label = item.device_label.clone().unwrap_or_else(|| {
            req.headers()
                .get("user-agent")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.chars().take(120).collect::<String>())
                .unwrap_or_else(|| "Unknown device".to_string())
        });
        if let Err(e) = sqlx::query(
            "INSERT INTO db_trusted_devices (id, user_id, label, token_hash, expires_at)
             VALUES ($1, $2, $3, $4, $5)"
        )
        .bind(&device.id).bind(&user.id).bind(&label)
        .bind(&device.token_hash).bind(device.expires_at)
        .execute(pool.get_ref()).await
        {
            log::error!("trusted device insert: {}", e);
            None
        } else {
            Some(device.token)
        }
    } else {
        None
    };

    HttpResponse::Ok().json(serde_json::json!({
        "access_token": access_token,
        "refresh_token": refresh_token,
        "user": &user,
        "trusted_device_token": trusted_device_token,
    }))
}

// ── GET /auth/devices ──

pub async fn list_trusted_devices(
    pool: web::Data<DbPool>,
    user: AuthenticatedUser,
) -> impl Responder {
    let rows: Result<Vec<(String, Option<String>, chrono::DateTime<chrono::Utc>, chrono::DateTime<chrono::Utc>, Option<chrono::DateTime<chrono::Utc>>)>, _> =
        sqlx::query_as(
            "SELECT id, label, created_at, expires_at, last_used_at
             FROM db_trusted_devices
             WHERE user_id = $1 AND expires_at > NOW()
             ORDER BY created_at DESC"
        ).bind(&user.user_id).fetch_all(pool.get_ref()).await;

    match rows {
        Ok(rs) => HttpResponse::Ok().json(rs.into_iter().map(|(id, label, created_at, expires_at, last_used_at)| {
            serde_json::json!({
                "id": id,
                "label": label,
                "created_at": created_at,
                "expires_at": expires_at,
                "last_used_at": last_used_at,
            })
        }).collect::<Vec<_>>()),
        Err(e) => {
            log::error!("list devices: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

// ── DELETE /auth/devices/{id} ──

pub async fn revoke_trusted_device(
    pool: web::Data<DbPool>,
    user: AuthenticatedUser,
    path: web::Path<String>,
) -> impl Responder {
    let id = path.into_inner();
    match sqlx::query("DELETE FROM db_trusted_devices WHERE id = $1 AND user_id = $2")
        .bind(&id).bind(&user.user_id)
        .execute(pool.get_ref()).await
    {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::NoContent().finish(),
        Ok(_) => HttpResponse::NotFound().finish(),
        Err(e) => {
            log::error!("revoke device: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

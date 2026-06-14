use actix_web::{web, HttpRequest, HttpResponse, Responder};
use crate::db::db::DbPool;
use super::models::{
    AuthenticatedUser, User, RegisterRequest, LoginRequest,
    RefreshTokenRequest, AuthResponse, Claims, UpdateProfileRequest,
};
use super::keys;
use super::rate_limit::{client_ip, RateLimiter};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use uuid::Uuid;
use jsonwebtoken::{encode, decode, Header, Algorithm, Validation};
use chrono::{Utc, Duration};
use serde::Deserialize;
use std::time::Duration as StdDuration;

// ── Rate limit helper ──
//
// Returns Err(HttpResponse) preformatted as 429 with Retry-After if the bucket
// is exhausted. Call once at the top of a sensitive handler:
//   if let Err(r) = enforce_limit(&limiter, "login_ip", &client_ip(&req), 5, 900).await { return r; }
async fn enforce_limit(
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
        .check(scope, identifier, max, StdDuration::from_secs(window_secs))
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

// ── Extract frontend base URL from the incoming request ──
// Uses the request's Host header + X-Forwarded-Proto (set by nginx in prod)
// so links work in both local dev and production without any extra env var.

fn extract_frontend_base(req: &HttpRequest) -> String {
    let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "/".to_string());
    let base = if base_url.ends_with('/') { base_url } else { format!("{}/", base_url) };
    let conn = req.connection_info();
    let scheme = conn.scheme().to_owned();
    let host = conn.host().to_owned();
    drop(conn);
    format!("{}://{}{}", scheme, host, base)
}

// ── Argon2 with fast iterations (dev-friendly, still secure) ──

pub fn argon2_instance_pub() -> Argon2<'static> {
    argon2_instance()
}

pub(super) async fn fetch_user_full_pub(pool: &DbPool, where_clause: &str, bind_val: &str)
    -> Result<Option<User>, sqlx::Error>
{
    fetch_user_full(pool, where_clause, bind_val).await
}

pub(super) fn generate_tokens_pub(user: &User) -> Result<(String, String), String> {
    generate_tokens(user)
}

fn argon2_instance() -> Argon2<'static> {
    // t_cost=2 (iterations), m_cost=16384 (16 MB), p_cost=1 (parallelism)
    let params = Params::new(16384, 2, 1, None).expect("valid argon2 params");
    Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params)
}

// ── JWT helpers using RS256 ──

fn generate_tokens(user: &User) -> Result<(String, String), String> {
    let encoding_key = keys::encoding_key();

    let now = Utc::now();
    let iat = now.timestamp() as usize;

    // Access Token – 15 minutes
    let access_claims = Claims {
        sub: user.id.clone(),
        exp: (now + Duration::minutes(15)).timestamp() as usize,
        iat,
        token_type: "access".to_string(),
        email: Some(user.email.clone()),
        first_name: user.first_name.clone(),
        last_name: user.last_name.clone(),
        permissions: user.permissions.clone(),
        groups: user.groups.clone(),
    };

    let mut header = Header::new(Algorithm::RS256);
    header.typ = Some("JWT".to_string());

    let access_token = encode(&header, &access_claims, encoding_key)
        .map_err(|e| format!("Failed to generate access token: {}", e))?;

    // Refresh Token – 7 days
    let refresh_claims = Claims {
        sub: user.id.clone(),
        exp: (now + Duration::days(7)).timestamp() as usize,
        iat,
        token_type: "refresh".to_string(),
        email: None,
        first_name: None,
        last_name: None,
        permissions: Vec::new(),
        groups: Vec::new(),
    };

    let refresh_token = encode(&header, &refresh_claims, encoding_key)
        .map_err(|e| format!("Failed to generate refresh token: {}", e))?;

    Ok((access_token, refresh_token))
}

/// Helper: fetch a user with groups + permissions + profile by a WHERE clause
async fn fetch_user_full(pool: &DbPool, where_clause: &str, bind_val: &str) -> Result<Option<User>, sqlx::Error> {
    let query = format!(
        r#"
        WITH user_perms AS (
            SELECT ug.user_id, gp.permission_slug
            FROM db_user_groups ug
            JOIN db_group_permissions gp ON ug.group_slug = gp.group_slug
            UNION
            SELECT user_id, permission_slug
            FROM db_user_permissions
        )
        SELECT
            u.id, u.email, u.password_hash, u.created_at, u.updated_at, u.is_verified,
            u.otp_secret, u.otp_enabled,
            COALESCE(array_agg(DISTINCT ug.group_slug) FILTER (WHERE ug.group_slug IS NOT NULL), '{{}}') as groups,
            COALESCE(array_agg(DISTINCT up.permission_slug) FILTER (WHERE up.permission_slug IS NOT NULL), '{{}}') as permissions,
            p.first_name, p.last_name, p.phone, p.location, p.bio, p.birth_date,
            p.language, p.timezone, p.avatar_url
        FROM db_users u
        LEFT JOIN db_user_groups ug ON u.id = ug.user_id
        LEFT JOIN user_perms up ON u.id = up.user_id
        LEFT JOIN db_user_profiles p ON u.id = p.user_id
        WHERE {}
        GROUP BY u.id, p.first_name, p.last_name, p.phone, p.location, p.bio, p.birth_date, p.language, p.timezone, p.avatar_url
        "#,
        where_clause
    );

    sqlx::query_as::<_, User>(&query)
        .bind(bind_val)
        .fetch_optional(pool)
        .await
}

// ── POST /auth/register ──

pub async fn register(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    item: web::Json<RegisterRequest>,
) -> impl Responder {
    // Check if registration is allowed via env var (default: disabled)
    if std::env::var("ALLOW_REGISTRATION").unwrap_or_else(|_| "false".to_string()) != "true" {
        return HttpResponse::Forbidden().json("Registration is currently disabled");
    }

    // H1 — rate limit by IP (cheap to fake by switching IP, but stops casual
    // abuse) and by email (caps email-flood on the verification mailer).
    let ip = client_ip(&req);
    if let Err(r) = enforce_limit(&limiter, "register_ip", &ip, 10, 3600).await { return r; }
    if let Err(r) = enforce_limit(&limiter, "register_email", &item.email, 3, 3600).await { return r; }

    let frontend_base = extract_frontend_base(&req);

    // H3 — server-side password policy
    if let Err(msg) = validate_password_policy(&item.email, &item.password) {
        return HttpResponse::BadRequest().json(msg);
    }
    if !is_plausible_email(&item.email) {
        return HttpResponse::BadRequest().json("Invalid email");
    }

    // Hash password (outside the transaction — it's CPU-bound, no DB locks held)
    let salt = SaltString::generate(&mut OsRng);
    let password_hash = match argon2_instance().hash_password(item.password.as_bytes(), &salt) {
        Ok(h) => h.to_string(),
        Err(e) => {
            log::error!("Argon2 hash error: {}", e);
            return HttpResponse::InternalServerError().json("Failed to hash password");
        }
    };

    let id = format!("user_{}", Uuid::new_v4());

    // C2 — atomic registration:
    // existence check + first-user check + all inserts run in one transaction,
    // and the `one_admin_only` partial unique index guarantees at most one admin
    // even if two requests race past the count() snapshot.
    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            log::error!("DB begin tx error: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    let exists: (i64,) = match sqlx::query_as(
        "SELECT count(*) FROM db_users WHERE email = $1"
    )
    .bind(&item.email)
    .fetch_one(&mut *tx)
    .await {
        Ok(v) => v,
        Err(e) => {
            log::error!("DB error checking user: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };
    if exists.0 > 0 {
        return HttpResponse::BadRequest().json("User already exists");
    }

    let total: (i64,) = match sqlx::query_as("SELECT count(*) FROM db_users")
        .fetch_one(&mut *tx)
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("DB count error: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };
    let is_first_user = total.0 == 0;
    let default_group = if is_first_user { "admin_group" } else { "viewer_group" };

    if let Err(e) = sqlx::query(
        "INSERT INTO db_users (id, email, password_hash, is_verified)
         VALUES ($1, $2, $3, $4)"
    )
    .bind(&id).bind(&item.email).bind(&password_hash).bind(is_first_user)
    .execute(&mut *tx).await
    {
        log::error!("DB insert user error: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO db_user_groups (user_id, group_slug) VALUES ($1, $2)"
    )
    .bind(&id).bind(default_group)
    .execute(&mut *tx).await
    {
        // unique-index violation on admin → race lost; surface as conflict
        log::warn!("DB insert group error (possible admin race): {}", e);
        return HttpResponse::Conflict().json("Registration failed");
    }

    if let Err(e) = sqlx::query(
        "INSERT INTO db_user_profiles (user_id) VALUES ($1)"
    )
    .bind(&id)
    .execute(&mut *tx).await
    {
        log::error!("DB insert profile error: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    if let Err(e) = tx.commit().await {
        log::error!("DB commit error: {}", e);
        return HttpResponse::InternalServerError().finish();
    }

    if is_first_user {
        return HttpResponse::Created().json("Registration successful. You are automatically verified as the first admin user.");
    }

    // Generate email verification token (24h expiry) — best-effort, outside tx
    let token = Uuid::new_v4().to_string();
    let expires_at = Utc::now() + Duration::hours(24);
    if let Err(e) = sqlx::query(
        "INSERT INTO db_registration_verifications (token, user_id, expires_at) VALUES ($1, $2, $3)"
    )
    .bind(&token).bind(&id).bind(expires_at)
    .execute(pool.get_ref()).await {
        log::error!("Failed to insert verification token: {}", e);
    } else {
        let email_addr = item.email.clone();
        let pool_c = pool.get_ref().clone();
        tokio::spawn(async move {
            if let Err(e) = crate::apps::email::service::send_verification_email(&pool_c, &email_addr, &token, &frontend_base).await {
                log::error!("Failed to send verification email to {}: {}", &email_addr, e);
            }
        });
    }
    HttpResponse::Created().json("Registration successful. Please check your email to verify your account.")
}

// ── H3: password policy + email sanity ──

fn validate_password_policy(email: &str, password: &str) -> Result<(), &'static str> {
    if password.len() < 10 {
        return Err("Password must be at least 10 characters");
    }
    if password.len() > 256 {
        return Err("Password is too long");
    }
    if password.eq_ignore_ascii_case(email) {
        return Err("Password cannot match your email");
    }
    let has_lower = password.chars().any(|c| c.is_ascii_lowercase());
    let has_upper = password.chars().any(|c| c.is_ascii_uppercase());
    let has_digit = password.chars().any(|c| c.is_ascii_digit());
    let has_symbol = password.chars().any(|c| !c.is_ascii_alphanumeric());
    let classes = [has_lower, has_upper, has_digit, has_symbol].iter().filter(|x| **x).count();
    if classes < 3 {
        return Err("Password must contain at least three of: lowercase, uppercase, digit, symbol");
    }
    Ok(())
}

fn is_plausible_email(email: &str) -> bool {
    // intentionally lax: format only, not deliverability.
    let len = email.len();
    if !(3..=254).contains(&len) {
        return false;
    }
    let mut parts = email.split('@');
    let local = parts.next().unwrap_or("");
    let domain = parts.next().unwrap_or("");
    if parts.next().is_some() {
        return false;
    }
    if local.is_empty() || domain.is_empty() || !domain.contains('.') {
        return false;
    }
    true
}

// ── POST /auth/login ──

pub async fn login(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    item: web::Json<LoginRequest>,
) -> impl Responder {
    // H1 — login bucket: 5 attempts per 15 minutes per IP AND per email so
    // either axis trips first.
    let ip = client_ip(&req);
    if let Err(r) = enforce_limit(&limiter, "login_ip", &ip, 10, 900).await { return r; }
    if let Err(r) = enforce_limit(&limiter, "login_email", &item.email, 5, 900).await { return r; }

    let user = match fetch_user_full(pool.get_ref(), "u.email = $1", &item.email).await {
        Ok(Some(u)) => u,
        Ok(None) => return HttpResponse::Unauthorized().json("Invalid credentials"),
        Err(e) => {
            log::error!("DB error: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    // Verify password
    let parsed_hash = match PasswordHash::new(&user.password_hash) {
        Ok(h) => h,
        Err(e) => {
            log::error!("Hash parse error: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    if argon2_instance().verify_password(item.password.as_bytes(), &parsed_hash).is_err() {
        return HttpResponse::Unauthorized().json("Invalid credentials");
    }

    // Password is correct. Past this point any "soft" response is gated behind
    // a correct password, so it cannot be used to enumerate users.

    if !user.is_verified {
        return HttpResponse::Ok().json(serde_json::json!({
            "step": "verify_email_required",
            "email": user.email,
        }));
    }

    // OTP gating: if the user has OTP enabled, hand back an otp_session
    // unless they presented a still-valid trusted-device token.
    if user.otp_enabled {
        let trusted = match &item.trusted_device_token {
            Some(t) if !t.is_empty() => trusted_device_matches_user(pool.get_ref(), &user.id, t).await,
            _ => false,
        };
        if !trusted {
            return match super::otp::issue_otp_session(&user.id) {
                Ok(otp_session) => HttpResponse::Ok().json(serde_json::json!({
                    "step": "otp_required",
                    "otp_session": otp_session,
                })),
                Err(e) => {
                    log::error!("otp session issue: {}", e);
                    HttpResponse::InternalServerError().finish()
                }
            };
        }
    }

    match generate_tokens(&user) {
        Ok((access_token, refresh_token)) => {
            HttpResponse::Ok().json(AuthResponse { access_token, refresh_token, user })
        }
        Err(e) => HttpResponse::InternalServerError().json(e),
    }
}

/// Returns true if `token` matches a non-expired trusted-device row for `user_id`.
/// Also bumps `last_used_at` so we can show "last seen" in the device list.
async fn trusted_device_matches_user(pool: &DbPool, user_id: &str, token: &str) -> bool {
    let Some(id) = super::otp::parse_trusted_device_id(token) else { return false };
    let hash = super::otp::hash_trusted_device(token);
    let row: Result<Option<(String,)>, _> = sqlx::query_as(
        "SELECT id FROM db_trusted_devices
         WHERE id = $1 AND user_id = $2 AND token_hash = $3 AND expires_at > NOW()"
    )
    .bind(id).bind(user_id).bind(&hash)
    .fetch_optional(pool).await;
    match row {
        Ok(Some(_)) => {
            let _ = sqlx::query("UPDATE db_trusted_devices SET last_used_at = NOW() WHERE id = $1")
                .bind(id).execute(pool).await;
            true
        }
        _ => false,
    }
}

// ── POST /auth/refresh ──

pub async fn refresh_token(
    pool: web::Data<DbPool>,
    item: web::Json<RefreshTokenRequest>,
) -> impl Responder {
    let decoding_key = keys::decoding_key();

    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = 5;

    let token_data = match decode::<Claims>(&item.refresh_token, decoding_key, &validation) {
        Ok(d) => d,
        Err(e) => {
            log::warn!("Refresh decode error: {}", e);
            return HttpResponse::Unauthorized().json("Invalid refresh token");
        }
    };

    if token_data.claims.token_type != "refresh" {
        return HttpResponse::Unauthorized().json("Invalid token type");
    }

    let user = match fetch_user_full(pool.get_ref(), "u.id = $1", &token_data.claims.sub).await {
        Ok(Some(u)) => u,
        Ok(None) => return HttpResponse::Unauthorized().json("User not found"),
        Err(e) => {
            log::error!("DB error: {}", e);
            return HttpResponse::InternalServerError().finish();
        }
    };

    match generate_tokens(&user) {
        Ok((access_token, refresh_token)) => {
            HttpResponse::Ok().json(AuthResponse { access_token, refresh_token, user })
        }
        Err(e) => HttpResponse::InternalServerError().json(e),
    }
}

// ── GET /auth/me ──

pub async fn get_me(
    pool: web::Data<DbPool>,
    user: AuthenticatedUser,
) -> impl Responder {
    match fetch_user_full(pool.get_ref(), "u.id = $1", &user.user_id).await {
        Ok(Some(u)) => HttpResponse::Ok().json(u),
        Ok(None) => HttpResponse::NotFound().json("User not found"),
        Err(e) => {
            log::error!("DB error: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

// ── PUT /auth/profile ──

pub async fn update_profile(
    pool: web::Data<DbPool>,
    user: AuthenticatedUser,
    item: web::Json<UpdateProfileRequest>,
) -> impl Responder {
    let result = sqlx::query(
        r#"
        INSERT INTO db_user_profiles (user_id, first_name, last_name, phone, location, bio, birth_date, language, timezone)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (user_id) DO UPDATE SET
            first_name = COALESCE(EXCLUDED.first_name, db_user_profiles.first_name),
            last_name = COALESCE(EXCLUDED.last_name, db_user_profiles.last_name),
            phone = COALESCE(EXCLUDED.phone, db_user_profiles.phone),
            location = COALESCE(EXCLUDED.location, db_user_profiles.location),
            bio = COALESCE(EXCLUDED.bio, db_user_profiles.bio),
            birth_date = COALESCE(EXCLUDED.birth_date, db_user_profiles.birth_date),
            language = COALESCE(EXCLUDED.language, db_user_profiles.language),
            timezone = COALESCE(EXCLUDED.timezone, db_user_profiles.timezone)
        "#
    )
    .bind(&user.user_id)
    .bind(&item.first_name)
    .bind(&item.last_name)
    .bind(&item.phone)
    .bind(&item.location)
    .bind(&item.bio)
    .bind(&item.birth_date)
    .bind(&item.language)
    .bind(&item.timezone)
    .execute(pool.get_ref())
    .await;

    match result {
        Ok(_) => {
            match fetch_user_full(pool.get_ref(), "u.id = $1", &user.user_id).await {
                Ok(Some(u)) => HttpResponse::Ok().json(u),
                _ => HttpResponse::Ok().json("Profile updated"),
            }
        }
        Err(e) => {
            log::error!("Profile update error: {}", e);
            HttpResponse::InternalServerError().finish()
        }
    }
}

// ── POST /auth/request-password-reset ──

#[derive(Deserialize)]
pub struct RequestPasswordResetRequest {
    email: String,
}

pub async fn request_password_reset(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    item: web::Json<RequestPasswordResetRequest>,
) -> impl Responder {
    // H1 — heavily throttled: this triggers an outbound email per call.
    let ip = client_ip(&req);
    if let Err(r) = enforce_limit(&limiter, "pwreset_req_ip", &ip, 5, 3600).await { return r; }
    if let Err(r) = enforce_limit(&limiter, "pwreset_req_email", &item.email, 3, 3600).await { return r; }

    let frontend_base = extract_frontend_base(&req);
    // Always return success to not leak user existence
    let user_result: Result<Option<(String,)>, _> = sqlx::query_as(
        "SELECT id FROM db_users WHERE email = $1"
    )
    .bind(&item.email)
    .fetch_optional(pool.get_ref())
    .await;

    if let Ok(Some((user_id,))) = user_result {
        let _ = sqlx::query("DELETE FROM db_password_resets WHERE user_id = $1")
            .bind(&user_id).execute(pool.get_ref()).await;

        let token = Uuid::new_v4().to_string();
        let expires_at = Utc::now() + Duration::hours(1);

        let _ = sqlx::query(
            "INSERT INTO db_password_resets (token, user_id, expires_at) VALUES ($1, $2, $3)"
        )
        .bind(&token).bind(&user_id).bind(expires_at)
        .execute(pool.get_ref()).await;

        let email_addr = item.email.clone();
        let pool_c = pool.get_ref().clone();
        tokio::spawn(async move {
            if let Err(e) = crate::apps::email::service::send_password_reset_email(&pool_c, &email_addr, &token, &frontend_base).await {
                log::error!("Failed to send password reset email to {}: {}", &email_addr, e);
            }
        });
    }

    HttpResponse::Ok().json("If that email exists, a reset link has been sent.")
}

// ── POST /auth/reset-password ──

#[derive(Deserialize)]
pub struct ResetPasswordRequest {
    token: String,
    new_password: String,
}

pub async fn reset_password(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    item: web::Json<ResetPasswordRequest>,
) -> impl Responder {
    // H1 — token brute-force defense.
    let ip = client_ip(&req);
    if let Err(r) = enforce_limit(&limiter, "pwreset_apply_ip", &ip, 10, 3600).await { return r; }

    // H2 — every failure path returns the same generic error so the endpoint
    // cannot be used to probe token validity.
    const GENERIC_FAIL: &str = "Invalid request";

    let user_row: Result<(String, String), _> = sqlx::query_as(
        "SELECT pr.user_id, u.email
         FROM db_password_resets pr
         JOIN db_users u ON u.id = pr.user_id
         WHERE pr.token = $1 AND pr.expires_at > NOW()"
    )
    .bind(&item.token)
    .fetch_one(pool.get_ref())
    .await;

    let (user_id, email) = match user_row {
        Ok(row) => row,
        Err(_) => return HttpResponse::BadRequest().json(GENERIC_FAIL),
    };

    if validate_password_policy(&email, &item.new_password).is_err() {
        return HttpResponse::BadRequest().json(GENERIC_FAIL);
    }

    let salt = SaltString::generate(&mut OsRng);
    let hash = match argon2_instance().hash_password(item.new_password.as_bytes(), &salt) {
        Ok(h) => h.to_string(),
        Err(_) => return HttpResponse::BadRequest().json(GENERIC_FAIL),
    };

    let _ = sqlx::query("UPDATE db_users SET password_hash = $1 WHERE id = $2")
        .bind(&hash).bind(&user_id).execute(pool.get_ref()).await;
    let _ = sqlx::query("DELETE FROM db_password_resets WHERE token = $1")
        .bind(&item.token).execute(pool.get_ref()).await;

    HttpResponse::Ok().json("Password reset successfully")
}

// ── GET /auth/verify?token=... ──

#[derive(Deserialize)]
pub struct VerifyEmailQuery {
    pub token: String,
}

pub async fn verify_email(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    query: web::Query<VerifyEmailQuery>,
) -> impl Responder {
    // H1 — verification tokens are UUID v4 (122 bits), already brute-resistant,
    // but rate-limit anyway to stop noise.
    let ip = client_ip(&req);
    if let Err(r) = enforce_limit(&limiter, "verify_ip", &ip, 30, 3600).await { return r; }

    let result: Result<(String,), _> = sqlx::query_as(
        "SELECT user_id FROM db_registration_verifications WHERE token = $1 AND expires_at > NOW()"
    )
    .bind(&query.token)
    .fetch_one(pool.get_ref())
    .await;

    match result {
        Ok((user_id,)) => {
            let _ = sqlx::query("UPDATE db_users SET is_verified = true WHERE id = $1")
                .bind(&user_id).execute(pool.get_ref()).await;
            let _ = sqlx::query("DELETE FROM db_registration_verifications WHERE token = $1")
                .bind(&query.token).execute(pool.get_ref()).await;
            HttpResponse::Ok().json("Email verified successfully. You can now log in.")
        }
        Err(_) => HttpResponse::BadRequest().json("Invalid or expired verification token"),
    }
}

// ── POST /auth/resend-verification ──

#[derive(Deserialize)]
pub struct ResendVerificationRequest {
    pub email: String,
}

pub async fn resend_verification(
    req: HttpRequest,
    pool: web::Data<DbPool>,
    limiter: web::Data<RateLimiter>,
    item: web::Json<ResendVerificationRequest>,
) -> impl Responder {
    // H1 — strict throttle: triggers outbound email.
    let ip = client_ip(&req);
    if let Err(r) = enforce_limit(&limiter, "resend_verify_ip", &ip, 5, 3600).await { return r; }
    if let Err(r) = enforce_limit(&limiter, "resend_verify_email", &item.email, 2, 3600).await { return r; }

    let frontend_base = extract_frontend_base(&req);
    // Always return success to avoid email enumeration
    let result: Result<Option<(String, bool)>, _> = sqlx::query_as(
        "SELECT id, is_verified FROM db_users WHERE email = $1"
    )
    .bind(&item.email)
    .fetch_optional(pool.get_ref())
    .await;

    if let Ok(Some((user_id, false))) = result {
        // Delete any existing tokens for this user
        let _ = sqlx::query("DELETE FROM db_registration_verifications WHERE user_id = $1")
            .bind(&user_id).execute(pool.get_ref()).await;

        let token = Uuid::new_v4().to_string();
        let expires_at = Utc::now() + Duration::hours(24);

        if let Ok(_) = sqlx::query(
            "INSERT INTO db_registration_verifications (token, user_id, expires_at) VALUES ($1, $2, $3)"
        )
        .bind(&token).bind(&user_id).bind(expires_at)
        .execute(pool.get_ref()).await {
            let email_addr = item.email.clone();
            let pool_c = pool.get_ref().clone();
            tokio::spawn(async move {
                if let Err(e) = crate::apps::email::service::send_verification_email(&pool_c, &email_addr, &token, &frontend_base).await {
                    log::error!("Failed to resend verification email to {}: {}", &email_addr, e);
                }
            });
        }
    }

    HttpResponse::Ok().json("If your email is registered and unverified, a new verification link has been sent.")
}

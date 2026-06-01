use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use chrono::{DateTime, Utc};

// ── DB Models ──

#[derive(Debug, Serialize, Deserialize, FromRow)]
pub struct User {
    pub id: String,
    pub email: String,
    #[serde(skip_serializing)]
    pub password_hash: String,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    #[sqlx(default)]
    pub is_verified: bool,
    #[sqlx(default)]
    #[serde(skip_serializing)]
    pub otp_secret: Option<String>,
    #[sqlx(default)]
    pub otp_enabled: bool,
    #[sqlx(default)]
    pub groups: Vec<String>,
    #[sqlx(default)]
    pub permissions: Vec<String>,
    // Profile fields (from LEFT JOIN)
    #[sqlx(default)]
    pub first_name: Option<String>,
    #[sqlx(default)]
    pub last_name: Option<String>,
    #[sqlx(default)]
    pub phone: Option<String>,
    #[sqlx(default)]
    pub location: Option<String>,
    #[sqlx(default)]
    pub bio: Option<String>,
    #[sqlx(default)]
    pub birth_date: Option<chrono::NaiveDate>,
    #[sqlx(default)]
    pub language: Option<String>,
    #[sqlx(default)]
    pub timezone: Option<String>,
    #[sqlx(default)]
    pub avatar_url: Option<String>,
}

// ── Request / Response ──

#[derive(Debug, Deserialize)]
pub struct RegisterRequest {
    pub email: String,
    pub password: String,
}

#[derive(Debug, Deserialize)]
pub struct LoginRequest {
    pub email: String,
    pub password: String,
    /// Optional trusted-device token previously issued to this client. When
    /// valid and matching the same user, login skips the OTP second step.
    #[serde(default)]
    pub trusted_device_token: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct RefreshTokenRequest {
    pub refresh_token: String,
}

#[derive(Debug, Serialize)]
pub struct AuthResponse {
    pub access_token: String,
    pub refresh_token: String,
    pub user: User,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileRequest {
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub phone: Option<String>,
    pub location: Option<String>,
    pub bio: Option<String>,
    pub birth_date: Option<chrono::NaiveDate>,
    pub language: Option<String>,
    pub timezone: Option<String>,
}

// ── JWT Claims ──

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Claims {
    pub sub: String,        // user id
    pub exp: usize,
    pub iat: usize,
    pub token_type: String, // "access" or "refresh"
    pub email: Option<String>,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    #[serde(default)]
    pub permissions: Vec<String>,
    #[serde(default)]
    pub groups: Vec<String>,
}

// ── Extractor model (used by middleware FromRequest) ──

#[derive(Debug, Clone, Serialize)]
pub struct AuthenticatedUser {
    pub user_id: String,
    pub email: String,
    pub first_name: Option<String>,
    pub last_name: Option<String>,
    pub permissions: Vec<String>,
    pub groups: Vec<String>,
}

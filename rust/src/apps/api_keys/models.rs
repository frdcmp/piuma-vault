use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ── Request models ──

#[derive(Debug, Deserialize)]
pub struct CreateApiKeyRequest {
    pub name: String,
    #[serde(default)]
    pub permissions: Vec<String>,
    pub expires_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateApiKeyRequest {
    pub name: Option<String>,
    pub permissions: Option<Vec<String>>,
    pub is_active: Option<bool>,
    pub expires_at: Option<Option<DateTime<Utc>>>,
}

// ── Response models ──

#[derive(Debug, Serialize)]
pub struct ApiKeyResponse {
    pub id: Uuid,
    pub name: String,
    pub key_prefix: String,
    pub permissions: Vec<String>,
    pub created_by: Option<String>,
    pub is_active: bool,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Returned ONLY on creation — the raw key is never stored or shown again.
#[derive(Debug, Serialize)]
pub struct CreateApiKeyResponse {
    pub id: Uuid,
    pub name: String,
    pub key_prefix: String,
    pub raw_key: String,
    pub permissions: Vec<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct RevokeApiKeyResponse {
    pub id: Uuid,
    pub is_active: bool,
}

#[derive(Debug, Serialize)]
pub struct ApiErrorResponse {
    pub error: String,
}

// ── DB row model (for internal use) ──

#[derive(Debug, sqlx::FromRow)]
pub struct ApiKeyRow {
    pub id: Uuid,
    pub name: String,
    pub key_prefix: String,
    pub key_hash: String,
    pub permissions: Vec<String>,
    pub created_by: Option<String>,
    pub is_active: bool,
    pub last_used_at: Option<DateTime<Utc>>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}
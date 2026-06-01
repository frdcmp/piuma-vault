use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ── DB model ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct FolderShare {
    pub id: uuid::Uuid,
    pub prefix: String,
    pub slug: String,
    pub access_level: String, // "view" | "edit"
    pub password_hash: Option<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub max_upload_bytes: Option<i64>,
    pub created_by: String,
    pub created_at: Option<DateTime<Utc>>,
    pub last_accessed_at: Option<DateTime<Utc>>,
}

// ── Admin request DTOs ──

#[derive(Debug, Deserialize)]
pub struct CreateFolderShareRequest {
    pub prefix: String,
    pub access_level: Option<String>,
    pub password: Option<String>,
    pub expires_in_hours: Option<i64>,
    pub max_upload_bytes: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateFolderShareRequest {
    pub access_level: Option<String>,
    pub password: Option<String>,
    // Some(Some(h)) = set expiry, Some(None) = remove expiry, None = leave unchanged.
    pub expires_in_hours: Option<Option<i64>>,
    pub is_active: Option<bool>,
}

// ── Admin response DTOs ──

#[derive(Debug, Serialize)]
pub struct CreateFolderShareResponse {
    pub id: uuid::Uuid,
    pub slug: String,
    pub prefix: String,
    pub access_level: String,
    pub has_password: bool,
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct FolderShareListItem {
    pub id: uuid::Uuid,
    pub slug: String,
    pub prefix: String,
    pub access_level: String,
    pub has_password: bool,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub last_accessed_at: Option<DateTime<Utc>>,
    pub url: String,
}

// ── Generic error ──

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
}

// ── Public DTOs (everything is RELATIVE to the share's prefix) ──

#[derive(Debug, Deserialize)]
pub struct PwdQuery {
    pub pwd: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PublicShareMeta {
    pub slug: String,
    pub access_level: String,
    pub can_edit: bool,
    pub requires_password: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub root_name: String,
}

#[derive(Debug, Deserialize)]
pub struct PublicListQuery {
    pub pwd: Option<String>,
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PublicFile {
    pub name: String,
    pub key: String, // relative to the share root
    pub size: i64,
    pub last_modified: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct PublicListResponse {
    pub path: String,
    pub folders: Vec<String>, // relative folder paths (trailing slash)
    pub files: Vec<PublicFile>,
}

#[derive(Debug, Deserialize)]
pub struct PathBody {
    pub path: String,
}

#[derive(Debug, Deserialize)]
pub struct ZipBody {
    pub path: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct PresignBody {
    pub path: String,
    pub content_type: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct MoveBody {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Serialize)]
pub struct UrlResponse {
    pub url: String,
}

#[derive(Debug, Serialize)]
pub struct PresignResponse {
    pub url: String,
    pub key: String,
}

#[derive(Debug, Serialize)]
pub struct OkResponse {
    pub ok: bool,
}

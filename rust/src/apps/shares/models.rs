use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ── DB Model ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct NoteShare {
    pub id: uuid::Uuid,
    pub note_id: uuid::Uuid,
    pub slug: String,
    pub access_level: String,
    pub password_hash: Option<String>,
    /// Reversible ciphertext of the password (owner-only recovery; see `crypto`).
    pub password_enc: Option<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_by: String,
    pub created_at: Option<DateTime<Utc>>,
    pub last_accessed_at: Option<DateTime<Utc>>,
}

// ── Request DTOs ──

#[derive(Debug, Deserialize)]
pub struct CreateShareRequest {
    pub access_level: Option<String>,
    pub password: Option<String>,
    pub expires_in_hours: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateShareRequest {
    pub access_level: Option<String>,
    pub password: Option<String>,
    pub expires_in_hours: Option<Option<i64>>, // Some(Some(h)) = set expiry, Some(None) = remove expiry, None = don't change
    pub is_active: Option<bool>,
}

// ── Response DTOs ──

#[derive(Debug, Serialize)]
pub struct CreateShareResponse {
    pub id: uuid::Uuid,
    pub note_id: uuid::Uuid,
    pub slug: String,
    pub access_level: String,
    pub has_password: bool,
    pub url: String,
}

/// A note share enriched with its note's title, for the central admin Shares
/// page (which lists every share across all notes).
#[derive(Debug, Serialize)]
pub struct NoteShareAdminItem {
    pub id: uuid::Uuid,
    pub note_id: uuid::Uuid,
    pub note_title: String,
    pub slug: String,
    pub access_level: String,
    pub has_password: bool,
    /// Decrypted password (owner-only), so the page can show/copy it.
    pub password: Option<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub last_accessed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct ShareListItem {
    pub id: uuid::Uuid,
    pub slug: String,
    pub access_level: String,
    pub has_password: bool,
    /// Decrypted password, returned only to the authenticated note owner so the
    /// Share modal can rebuild a `?pwd=` link. `None` when the share has none.
    pub password: Option<String>,
    pub is_active: bool,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: Option<DateTime<Utc>>,
    pub last_accessed_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct SharesApiError {
    pub error: String,
}

// ── Public endpoint DTOs ──

#[derive(Debug, Deserialize)]
pub struct PublicShareQuery {
    pub pwd: Option<String>,
    pub format: Option<String>, // markdown, json, html
}

#[derive(Debug, Serialize)]
pub struct PublicShareResponse {
    pub note: PublicNoteData,
    pub share: PublicShareInfo,
}

#[derive(Debug, Serialize)]
pub struct PublicNoteData {
    pub id: uuid::Uuid,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Serialize)]
pub struct PublicShareInfo {
    pub slug: String,
    pub access_level: String,
    pub expires_at: Option<DateTime<Utc>>,
}

// ── Frontmatter for markdown format ──

#[derive(Debug, Serialize)]
pub struct NoteFrontmatter {
    pub id: uuid::Uuid,
    pub title: String,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub updated_at: Option<DateTime<Utc>>,
    pub access: String,
}

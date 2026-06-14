//! Email account models (Services → Email).
//!
//! Each account independently enables SMTP send and/or IMAP read. Passwords are
//! stored encrypted (apps::shares::crypto) and never serialized back to the
//! client — responses expose only `*_password_set` booleans, mirroring the
//! Services secret-masking convention.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// Full DB row. `smtp_password` / `imap_password` hold ciphertext.
#[derive(Debug, Clone, FromRow)]
pub struct EmailAccount {
    pub id: Uuid,
    pub label: String,
    pub email_address: String,
    pub send_enabled: bool,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_security: String,
    pub smtp_username: String,
    pub smtp_password: String,
    pub read_enabled: bool,
    pub imap_host: String,
    pub imap_port: i32,
    pub imap_security: String,
    pub imap_username: String,
    pub imap_password: String,
    pub is_default: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Client-facing view — secrets masked to `*_set` booleans.
#[derive(Debug, Serialize)]
pub struct EmailAccountResponse {
    pub id: Uuid,
    pub label: String,
    pub email_address: String,
    pub send_enabled: bool,
    pub smtp_host: String,
    pub smtp_port: i32,
    pub smtp_security: String,
    pub smtp_username: String,
    pub smtp_password_set: bool,
    pub read_enabled: bool,
    pub imap_host: String,
    pub imap_port: i32,
    pub imap_security: String,
    pub imap_username: String,
    pub imap_password_set: bool,
    pub is_default: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<EmailAccount> for EmailAccountResponse {
    fn from(a: EmailAccount) -> Self {
        Self {
            id: a.id,
            label: a.label,
            email_address: a.email_address,
            send_enabled: a.send_enabled,
            smtp_host: a.smtp_host,
            smtp_port: a.smtp_port,
            smtp_security: a.smtp_security,
            smtp_username: a.smtp_username,
            smtp_password_set: !a.smtp_password.trim().is_empty(),
            read_enabled: a.read_enabled,
            imap_host: a.imap_host,
            imap_port: a.imap_port,
            imap_security: a.imap_security,
            imap_username: a.imap_username,
            imap_password_set: !a.imap_password.trim().is_empty(),
            is_default: a.is_default,
            created_at: a.created_at,
            updated_at: a.updated_at,
        }
    }
}

/// Create payload. Non-secret fields default; passwords are plaintext here.
#[derive(Debug, Deserialize)]
pub struct CreateEmailAccount {
    pub label: String,
    pub email_address: String,
    #[serde(default)]
    pub send_enabled: bool,
    #[serde(default)]
    pub smtp_host: String,
    #[serde(default = "default_smtp_port")]
    pub smtp_port: i32,
    #[serde(default = "default_smtp_security")]
    pub smtp_security: String,
    #[serde(default)]
    pub smtp_username: String,
    #[serde(default)]
    pub smtp_password: String,
    #[serde(default)]
    pub read_enabled: bool,
    #[serde(default)]
    pub imap_host: String,
    #[serde(default = "default_imap_port")]
    pub imap_port: i32,
    #[serde(default = "default_imap_security")]
    pub imap_security: String,
    #[serde(default)]
    pub imap_username: String,
    #[serde(default)]
    pub imap_password: String,
    #[serde(default)]
    pub is_default: bool,
}

/// Partial update. Omitted field = unchanged; for passwords, empty string =
/// clear, non-empty = replace (leave-blank-to-keep).
#[derive(Debug, Deserialize)]
pub struct UpdateEmailAccount {
    pub label: Option<String>,
    pub email_address: Option<String>,
    pub send_enabled: Option<bool>,
    pub smtp_host: Option<String>,
    pub smtp_port: Option<i32>,
    pub smtp_security: Option<String>,
    pub smtp_username: Option<String>,
    pub smtp_password: Option<String>,
    pub read_enabled: Option<bool>,
    pub imap_host: Option<String>,
    pub imap_port: Option<i32>,
    pub imap_security: Option<String>,
    pub imap_username: Option<String>,
    pub imap_password: Option<String>,
    pub is_default: Option<bool>,
}

/// Test a connection. May reference a saved account (`id`) and/or carry unsaved
/// form overrides — secrets fall back to the stored value when omitted, exactly
/// like the other Services test endpoints.
#[derive(Debug, Deserialize)]
pub struct TestConnectionRequest {
    pub id: Option<Uuid>,
    pub host: Option<String>,
    pub port: Option<i32>,
    pub security: Option<String>,
    pub username: Option<String>,
    pub password: Option<String>,
    /// SMTP only: address to send the test message to (defaults to username).
    pub to: Option<String>,
}

fn default_smtp_port() -> i32 {
    587
}
fn default_smtp_security() -> String {
    "starttls".to_string()
}
fn default_imap_port() -> i32 {
    993
}
fn default_imap_security() -> String {
    "ssl".to_string()
}

//! MCP server admin models. Responses mask `auth_token` to `auth_token_set`
//! (the Services secret convention); `tool_cache` is exposed read-only so the
//! UI can list a server's discovered tools without a live worker round-trip.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use uuid::Uuid;

/// Full DB row (`auth_token` in plain, like `db_llm_providers.api_key`).
#[derive(Debug, Clone, FromRow)]
pub struct McpServer {
    pub id: Uuid,
    pub name: String,
    pub transport: String,
    pub url: String,
    pub auth_token: String,
    pub command: String,
    pub args: Vec<String>,
    pub env: Value,
    pub enabled: bool,
    pub cron_safe: bool,
    pub timeout_secs: i32,
    pub last_status: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    pub tool_cache: Option<Value>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Client-facing view — token masked, env exposed as key names only (values
/// may be secrets too).
#[derive(Debug, Serialize)]
pub struct McpServerResponse {
    pub id: Uuid,
    pub name: String,
    pub transport: String,
    pub url: String,
    pub auth_token_set: bool,
    pub command: String,
    pub args: Vec<String>,
    pub env_keys: Vec<String>,
    pub enabled: bool,
    pub cron_safe: bool,
    pub timeout_secs: i32,
    pub last_status: Option<String>,
    pub last_checked_at: Option<DateTime<Utc>>,
    /// Names of the cached tools (full schemas stay server-side).
    pub tools: Vec<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl From<McpServer> for McpServerResponse {
    fn from(s: McpServer) -> Self {
        let tools = s
            .tool_cache
            .as_ref()
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(str::to_string))
                    .collect()
            })
            .unwrap_or_default();
        let env_keys = s
            .env
            .as_object()
            .map(|o| o.keys().cloned().collect())
            .unwrap_or_default();
        Self {
            id: s.id,
            name: s.name,
            transport: s.transport,
            url: s.url,
            auth_token_set: !s.auth_token.trim().is_empty(),
            command: s.command,
            args: s.args,
            env_keys,
            enabled: s.enabled,
            cron_safe: s.cron_safe,
            timeout_secs: s.timeout_secs,
            last_status: s.last_status,
            last_checked_at: s.last_checked_at,
            tools,
            created_at: s.created_at,
            updated_at: s.updated_at,
        }
    }
}

/// Create payload.
#[derive(Debug, Deserialize)]
pub struct CreateMcpServer {
    pub name: String,
    #[serde(default = "default_transport")]
    pub transport: String,
    #[serde(default)]
    pub url: String,
    #[serde(default)]
    pub auth_token: String,
    #[serde(default)]
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default = "empty_object")]
    pub env: Value,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub cron_safe: bool,
    #[serde(default = "default_timeout")]
    pub timeout_secs: i32,
}

/// Partial update. Omitted field = unchanged; for `auth_token`, empty string =
/// clear, non-empty = replace (leave-blank-to-keep). `env` replaces wholesale
/// when present (it's a small map, per-key patching isn't worth the API).
#[derive(Debug, Deserialize)]
pub struct UpdateMcpServer {
    pub name: Option<String>,
    pub transport: Option<String>,
    pub url: Option<String>,
    pub auth_token: Option<String>,
    pub command: Option<String>,
    pub args: Option<Vec<String>>,
    pub env: Option<Value>,
    pub enabled: Option<bool>,
    pub cron_safe: Option<bool>,
    pub timeout_secs: Option<i32>,
}

fn default_transport() -> String {
    "http".to_string()
}
fn default_true() -> bool {
    true
}
fn default_timeout() -> i32 {
    30
}
fn empty_object() -> Value {
    serde_json::json!({})
}

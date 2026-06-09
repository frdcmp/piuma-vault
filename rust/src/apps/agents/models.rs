//! Row structs (sqlx `FromRow`) and request/response DTOs for the agents module.
//! Provider API keys are stored plaintext but never serialised back to clients —
//! responses expose only a masked form + a `has_key` flag.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use sqlx::FromRow;
use uuid::Uuid;

fn empty_json() -> Json {
    serde_json::json!({})
}

// ── Providers ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow)]
pub struct ProviderRow {
    pub id: Uuid,
    pub kind: String,
    pub display_name: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub config: Json,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Serialize)]
pub struct ProviderResponse {
    pub id: Uuid,
    pub kind: String,
    pub display_name: String,
    pub api_key_masked: String,
    pub has_key: bool,
    pub base_url: Option<String>,
    pub config: Json,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Show only the last 4 chars of a key, e.g. `sk-•••••1a2b`.
pub fn mask_key(key: &str) -> String {
    let trimmed = key.trim();
    if trimmed.is_empty() {
        return String::new();
    }
    let tail: String = trimmed.chars().rev().take(4).collect::<Vec<_>>().into_iter().rev().collect();
    format!("•••••{tail}")
}

impl From<ProviderRow> for ProviderResponse {
    fn from(r: ProviderRow) -> Self {
        let has_key = !r.api_key.trim().is_empty();
        ProviderResponse {
            id: r.id,
            kind: r.kind,
            display_name: r.display_name,
            api_key_masked: mask_key(&r.api_key),
            has_key,
            base_url: r.base_url,
            config: r.config,
            enabled: r.enabled,
            created_at: r.created_at,
            updated_at: r.updated_at,
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct CreateProviderReq {
    pub kind: String,
    pub display_name: String,
    #[serde(default)]
    pub api_key: String,
    #[serde(default)]
    pub base_url: Option<String>,
    #[serde(default = "empty_json")]
    pub config: Json,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProviderReq {
    pub display_name: Option<String>,
    /// When present and non-empty, replaces the stored key. Empty string keeps it.
    pub api_key: Option<String>,
    pub base_url: Option<String>,
    pub config: Option<Json>,
    pub enabled: Option<bool>,
}

// ── Models ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ModelRow {
    pub id: Uuid,
    pub provider_id: Uuid,
    pub model_id: String,
    pub display_name: String,
    pub supports_thinking: bool,
    pub supports_tools: bool,
    pub supports_vision: bool,
    pub context_window: Option<i32>,
    pub config: Json,
    pub is_default: bool,
    pub enabled: bool,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateModelReq {
    pub model_id: String,
    pub display_name: String,
    #[serde(default)]
    pub supports_thinking: bool,
    #[serde(default = "default_true")]
    pub supports_tools: bool,
    #[serde(default)]
    pub supports_vision: bool,
    #[serde(default)]
    pub context_window: Option<i32>,
    #[serde(default = "empty_json")]
    pub config: Json,
    #[serde(default)]
    pub is_default: bool,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct UpdateModelReq {
    pub display_name: Option<String>,
    pub supports_thinking: Option<bool>,
    pub supports_tools: Option<bool>,
    pub supports_vision: Option<bool>,
    pub context_window: Option<i32>,
    pub config: Option<Json>,
    pub is_default: Option<bool>,
    pub enabled: Option<bool>,
}

// ── Agent profile + persona ────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct AgentProfileRow {
    pub agent: String,
    pub display_name: String,
    pub instructions: String,
    pub user_context: String,
    pub memory: String,
    /// Per-agent slash-command macros: [{ name, description, prompt }].
    pub commands: Json,
    pub dialectic_cadence: Option<i32>,
    pub dialectic_depth: Option<i32>,
    pub dialectic_model_id: Option<String>,
    pub dialectic_observe_vault: Option<bool>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateProfileReq {
    pub display_name: Option<String>,
    pub instructions: Option<String>,
    pub user_context: Option<String>,
    pub memory: Option<String>,
    pub commands: Option<Json>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct PersonaRow {
    pub id: Uuid,
    pub agent: String,
    pub name: String,
    pub display_name: String,
    pub emoji: Option<String>,
    pub system_prompt: String,
    pub allowed_tools: Option<Vec<String>>,
    pub config: Json,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePersonaReq {
    pub display_name: Option<String>,
    pub emoji: Option<String>,
    pub system_prompt: Option<String>,
    pub allowed_tools: Option<Vec<String>>,
    pub config: Option<Json>,
}

// ── Conversations + messages ────────────────────────────────────────────────

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct ConversationRow {
    pub id: Uuid,
    pub agent: String,
    pub title: Option<String>,
    pub model_id: Option<Uuid>,
    pub identity: String,
    pub metadata: Json,
    pub archived_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Deserialize)]
pub struct CreateConversationReq {
    pub agent: String,
    #[serde(default)]
    pub model_id: Option<Uuid>,
    #[serde(default)]
    pub title: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateConversationReq {
    pub title: Option<String>,
    pub model_id: Option<Uuid>,
    pub archived: Option<bool>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct MessageRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub role: String,
    pub content: Json,
    pub model_used: Option<String>,
    pub provider_kind: Option<String>,
    pub tokens_input: Option<i32>,
    pub tokens_output: Option<i32>,
    pub tokens_cached: Option<i32>,
    pub stop_reason: Option<String>,
    pub metadata: Json,
    pub created_at: DateTime<Utc>,
}

/// Body of POST /agents/conversations/{id}/chat — the new user message, plus
/// optional note ids whose content is injected as context for this turn (the
/// "locked note" chips in the chat UI).
#[derive(Debug, Deserialize)]
pub struct ChatTurnReq {
    pub message: String,
    #[serde(default)]
    pub context_note_ids: Vec<Uuid>,
    /// IANA timezone of the client (e.g. "Europe/Rome"), so the agent can
    /// resolve relative dates and emit correctly-offset timestamps.
    #[serde(default)]
    pub timezone: Option<String>,
    /// The client's current local datetime as RFC3339 *with offset*
    /// (e.g. "2026-06-05T14:52:00+02:00").
    #[serde(default)]
    pub client_now: Option<String>,
}

// ── Agent listing (registry + profile) ──────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct AgentInfo {
    pub kind: String,
    pub display_name: String,
    pub persona: String,
    pub tool_count: usize,
    /// Per-agent slash-command macros (from db_agent_profiles.commands).
    pub commands: Json,
}

#[derive(Debug, Deserialize)]
pub struct DefaultAgentReq {
    pub agent: String,
}

// ── Error ────────────────────────────────────────────────────────────────────

#[derive(Debug, Serialize)]
pub struct ApiError {
    pub error: String,
}

impl ApiError {
    pub fn new(msg: impl Into<String>) -> Self {
        ApiError { error: msg.into() }
    }
}

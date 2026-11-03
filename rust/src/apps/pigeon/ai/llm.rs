//! The model Pigeon writes with: one of the vault's own (admin → Agents), the one picked for
//! Pigeon (`app_settings` pigeon_model_id) or else the default. Two ways: plain text (a summary,
//! a style profile) and tool calls (the agent proposing actions). No streaming: nobody watches
//! it type. Each call's tokens go to the usage ledger as `pigeon`.

use futures::channel::mpsc;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::agents::models::{ModelRow, ProviderRow};
use crate::apps::agents::providers;
use crate::apps::settings::store;
use crate::db::db::DbPool;

/// The `app_settings` key naming the model Pigeon uses (a `db_llm_models` id).
pub const MODEL_SETTING: &str = "pigeon_model_id";

/// A tool call the model made: its name and parsed arguments.
#[derive(Debug, Clone)]
pub struct ToolCall {
    pub name: String,
    pub args: Json,
}

pub struct Reply {
    pub text: String,
    pub tool_calls: Vec<ToolCall>,
}

struct Resolved {
    kind: String,
    api_key: String,
    base_url: Option<String>,
    model: String,
}

async fn resolve(pool: &DbPool) -> anyhow::Result<Resolved> {
    let picked: Option<Uuid> = store::get(pool, MODEL_SETTING).await.and_then(|v| v.parse().ok());
    let model: Option<ModelRow> = match picked {
        Some(id) => sqlx::query_as("SELECT * FROM db_llm_models WHERE id = $1 AND enabled").bind(id).fetch_optional(pool).await?,
        None => None,
    };
    let model = match model {
        Some(m) => m,
        None => sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool)
            .await?
            .ok_or_else(|| anyhow::anyhow!("no model configured: add one in admin → Agents"))?,
    };
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("the model's provider is gone"))?;
    if !providers::supported(&provider.kind) {
        anyhow::bail!("provider kind '{}' is not supported", provider.kind);
    }
    Ok(Resolved { kind: provider.kind, api_key: provider.api_key, base_url: provider.base_url, model: model.model_id })
}

/// One turn: a system prompt, the user's message, the tools (OpenAI function tools: `{type:
/// function, function: {name, description, parameters}}`).
pub async fn complete(pool: &DbPool, system: &str, user: &str, tools: &[Json]) -> anyhow::Result<Reply> {
    let r = resolve(pool).await?;
    let messages = [json!({ "role": "system", "content": system }), json!({ "role": "user", "content": user })];
    // nobody streams it: the deltas go nowhere
    let (tx, _rx) = mpsc::unbounded();
    let res = providers::call(&r.kind, &r.api_key, r.base_url.as_deref(), &r.model, &messages, tools, &tx)
        .await
        .map_err(|e| anyhow::anyhow!("the model refused: {e}"))?;
    if res.tokens_in + res.tokens_out > 0 {
        let _ = sqlx::query(
            "INSERT INTO db_token_usage (kind, source, provider_kind, model, tokens_input, tokens_output, tokens_cached, tokens_cache_write)
             VALUES ('chat', 'pigeon', $1, $2, $3, $4, $5, $6)",
        )
        .bind(&r.kind)
        .bind(&r.model)
        .bind(res.tokens_in)
        .bind(res.tokens_out)
        .bind(res.tokens_cached)
        .bind(res.tokens_cache_write)
        .execute(pool)
        .await;
    }
    let tool_calls = res
        .tool_calls
        .into_iter()
        .map(|c| ToolCall { args: serde_json::from_str(&c.arguments).unwrap_or_else(|_| json!({})), name: c.name })
        .collect();
    Ok(Reply { text: res.text, tool_calls })
}

/// Plain text, no tools.
pub async fn text(pool: &DbPool, system: &str, user: &str) -> anyhow::Result<String> {
    Ok(complete(pool, system, user, &[]).await?.text.trim().to_string())
}

/// Whether a model is there to write with.
pub async fn available(pool: &DbPool) -> bool {
    resolve(pool).await.is_ok()
}

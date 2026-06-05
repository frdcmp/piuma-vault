//! Background generation of concise conversation titles.
//!
//! The chat turn sets a cheap fallback title (first 60 chars of the first
//! message) immediately so the row is never blank. After the first exchange
//! completes, `generate` replaces it with an LLM-written subject line using the
//! default agent model. Best-effort: any failure leaves the fallback in place.
//! Marked done via `metadata.ai_titled` so it runs at most once per
//! conversation and never clobbers a manual `/title` edit.

use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::db::DbPool;

use super::models::{ModelRow, ProviderRow};
use super::providers::deepseek;

const SYSTEM: &str = "You generate a short title for a chat conversation. \
Reply with ONLY the title: 3-6 words, no quotes, no trailing punctuation, in \
the same language as the conversation. Summarize the topic, not the greeting.";

/// Generate and store an AI title for `conv_id`, best-effort. Safe to call from
/// a spawned task. No-ops if already AI-titled or no default model is set.
pub async fn generate(pool: &DbPool, conv_id: Uuid) {
    let _ = run(pool, conv_id, false).await;
}

/// Force a re-title (ignores the `ai_titled` guard) and return the new title.
/// Used by the `/title → auto-rename` action. `None` if there's nothing to
/// summarize or no model is configured.
pub async fn regenerate(pool: &DbPool, conv_id: Uuid) -> Option<String> {
    run(pool, conv_id, true).await
}

/// Core generation. Resolves the default model, summarizes the first turns, and
/// stores the result. Returns the stored title, or `None` if it bailed.
async fn run(pool: &DbPool, conv_id: Uuid, force: bool) -> Option<String> {
    // Skip if already AI-titled (guards against repeat turns / races) unless the
    // caller forces a re-title.
    if !force {
        let already: Option<bool> = sqlx::query_scalar(
            "SELECT (metadata->>'ai_titled')::bool FROM db_chat_conversations WHERE id = $1",
        )
        .bind(conv_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
        if already == Some(true) {
            return None;
        }
    }

    // Resolve the default enabled model + its provider — same selection the
    // native chat path uses for an agent with no explicit model.
    let model: Option<ModelRow> =
        sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let Some(model) = model else { return None };
    let provider: Option<ProviderRow> =
        sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
            .bind(model.provider_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let Some(provider) = provider else { return None };
    if provider.kind != "deepseek" || provider.api_key.trim().is_empty() {
        return None;
    }

    // First couple of turns give the model real context to summarize.
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT role, content FROM db_chat_messages \
         WHERE conversation_id = $1 AND role IN ('user', 'assistant') \
         ORDER BY created_at LIMIT 4",
    )
    .bind(conv_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();

    let mut transcript = String::new();
    for (role, content) in &rows {
        let text = super::chat::blocks_to_text(content);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let snippet: String = text.chars().take(500).collect();
        transcript.push_str(&format!("{role}: {snippet}\n"));
    }
    if transcript.trim().is_empty() {
        return None;
    }

    let messages = vec![
        json!({ "role": "system", "content": SYSTEM }),
        json!({ "role": "user", "content": format!("Conversation:\n{transcript}\nTitle:") }),
    ];

    // Budget must cover the model's reasoning_content too: the default model is
    // a reasoning model, so a small cap leaves `content` empty (all tokens go to
    // reasoning). 512 comfortably fits the thinking plus a short title.
    let raw = match deepseek::complete(
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        &messages,
        512,
    )
    .await
    {
        Ok(t) => t,
        Err(e) => {
            log::warn!("title gen ({conv_id}): {e}");
            return None;
        }
    };

    let title = sanitize(&raw);
    if title.is_empty() {
        return None;
    }

    let _ = sqlx::query(
        "UPDATE db_chat_conversations \
         SET title = $2, metadata = metadata || '{\"ai_titled\": true}'::jsonb \
         WHERE id = $1",
    )
    .bind(conv_id)
    .bind(&title)
    .execute(pool)
    .await;
    Some(title)
}

/// Strip a leading "Title:" label, wrapping quotes, and trailing punctuation;
/// cap the length defensively.
fn sanitize(raw: &str) -> String {
    let mut s = raw.trim();
    for prefix in ["Title:", "title:"] {
        if let Some(rest) = s.strip_prefix(prefix) {
            s = rest.trim();
        }
    }
    let s = s.trim_matches('"').trim_matches('\'').trim();
    let s = s.trim_end_matches(['.', '!', '?', ':']).trim();
    s.chars().take(80).collect()
}

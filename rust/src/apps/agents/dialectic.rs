//! L4 dialectic reasoning — Honcho-style async post-turn insight derivation.
//!
//! After every `CADENCE` assistant turns, the last few turns are summarised by
//! the default model, which extracts implicit facts the user never explicitly
//! stated. Each is saved as a LOW-TRUST pending memory entry
//! (`source=dialectic_derived`, `confidence=medium`, 60-day TTL). Pending
//! entries auto-inject into retrieval only at the tighter distance floor and are
//! tagged `[derived, unconfirmed]`; they graduate to confirmed via the
//! confirmation funnel (user confirm / corroboration).
//!
//! Fire-and-forget from the chat loop: never blocks the user's turn, and any
//! failure is logged and dropped.

use uuid::Uuid;

use crate::db::db::DbPool;

use super::models::{ModelRow, ProviderRow};
use super::providers::deepseek;
use super::tools::memory;

/// Run the dialectic pass once every N assistant turns.
pub const CADENCE: i64 = 3;
/// Turns of transcript to analyse each run.
const LAST_N: i64 = 6;

const SYSTEM: &str = "You are a reasoning engine. Analyze a conversation between \
User and his AI agent and derive implicit facts, preferences, patterns, and \
goals that were NOT explicitly stated.\n\n\
Rules:\n\
- Only derive what is strongly implied, not what is merely possible.\n\
- Prefer specific facts over vague observations.\n\
- If nothing is strongly implied, output nothing.\n\
- Output one fact per line, each prefixed with a bracketed category:\n\
  [preference] User prefers X over Y\n\
  [pattern] User tends to do X when Y\n\
  [goal] User is working toward X\n\
  [convention] User's convention for X is Y\n\
  [constraint] User cannot X because Y\n\
Output ONLY the lines, no preamble.";

/// Entry point from the chat loop. Counts assistant turns and runs the pass only
/// on the cadence boundary. Safe to spawn; best-effort.
pub async fn maybe_run(pool: &DbPool, conv_id: Uuid, agent: String) {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_chat_messages WHERE conversation_id = $1 AND role = 'assistant'",
    )
    .bind(conv_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count == 0 || count % CADENCE != 0 {
        return;
    }
    if let Err(e) = run(pool, conv_id, &agent).await {
        log::warn!("dialectic ({conv_id}): {e}");
    }
}

async fn run(pool: &DbPool, conv_id: Uuid, agent: &str) -> Result<(), String> {
    // Resolve the default model + provider, same selection the chat path uses.
    let model: ModelRow = sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("no default model")?;
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("provider not found")?;
    if provider.kind != "deepseek" || provider.api_key.trim().is_empty() {
        return Ok(());
    }

    // Last N turns as a plain transcript.
    let rows: Vec<(String, serde_json::Value)> = sqlx::query_as(
        "SELECT role, content FROM db_chat_messages \
         WHERE conversation_id = $1 AND role IN ('user', 'assistant') \
         ORDER BY created_at DESC LIMIT $2",
    )
    .bind(conv_id)
    .bind(LAST_N)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut transcript = String::new();
    for (role, content) in rows.iter().rev() {
        let text = super::chat::blocks_to_text(content);
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        let snippet: String = text.chars().take(800).collect();
        transcript.push_str(&format!("{role}: {snippet}\n"));
    }
    if transcript.trim().is_empty() {
        return Ok(());
    }

    let messages = vec![
        serde_json::json!({ "role": "system", "content": SYSTEM }),
        serde_json::json!({ "role": "user", "content": format!("Conversation:\n---\n{transcript}---") }),
    ];

    // Generous budget: the default model is a reasoning model, so a small cap
    // leaves `content` empty (all tokens go to reasoning before any answer).
    let raw = deepseek::complete(
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        &messages,
        8000,
    )
    .await?;

    let insights = parse_insights(&raw);
    log::info!(
        "dialectic ({conv_id}): model returned {} chars, parsed {} insight(s)",
        raw.len(),
        insights.len()
    );

    let mut saved = 0;
    for (category, content) in insights {
        match memory::save_derived(pool, agent, &content, Some(&category), Some(conv_id)).await {
            Ok("inserted") | Ok("corroborated") => saved += 1,
            Ok(_) => {}
            Err(e) => log::warn!("dialectic save ({conv_id}): {e}"),
        }
    }
    if saved > 0 {
        log::info!("dialectic ({conv_id}): saved {saved} derived insight(s)");
    }
    Ok(())
}

/// Parse `[category] fact` lines into `(category, content)`. Lines without a
/// recognised bracket prefix are skipped (the model occasionally adds prose).
fn parse_insights(raw: &str) -> Vec<(String, String)> {
    raw.lines()
        .filter_map(|line| {
            let line = line.trim().trim_start_matches(['-', '*', ' ']);
            let rest = line.strip_prefix('[')?;
            let (cat, after) = rest.split_once(']')?;
            let content = after.trim();
            let cat = cat.trim().to_lowercase();
            if content.is_empty() || cat.is_empty() {
                return None;
            }
            Some((cat, content.to_string()))
        })
        .collect()
}

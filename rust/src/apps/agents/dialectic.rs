//! L4 dialectic reasoning — Honcho-style async post-turn insight derivation.
//!
//! After every N assistant turns (configurable per agent, default 3), the last
//! few turns are summarised by the dialectic model, which extracts implicit
//! facts the user never explicitly stated. Each is saved as a LOW-TRUST pending
//! memory entry (`source=dialectic_derived`, `confidence=medium`, 60-day TTL).
//! Pending entries auto-inject into retrieval only at the tighter distance floor
//! and are tagged `[derived, unconfirmed]`; they graduate to confirmed via the
//! confirmation funnel (user confirm / corroboration / opportunistic ask).
//!
//! Supports multi-pass depth (1-3): each pass feeds the previous pass's results
//! back for progressively deeper synthesis.
//!
//! Fire-and-forget from the chat loop: never blocks the user's turn, and any
//! failure is logged and dropped.

use uuid::Uuid;

use crate::db::db::DbPool;

use super::models::{AgentProfileRow, ModelRow, ProviderRow};
use super::providers;
use super::tools::memory;

/// Fallback cadence when the agent profile has no config.
const DEFAULT_CADENCE: i64 = 3;
/// Turns of transcript to analyse each run.
const LAST_N: i64 = 6;

const SYSTEM_PASS1: &str = "You are a reasoning engine. Analyze a conversation between \
the User and their AI agent and derive implicit facts, preferences, patterns, and \
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

const SYSTEM_PASS2: &str = "You are a reasoning engine. Below are observations derived \
from a conversation between the User and their AI agent. Synthesize these into \
broader patterns and deeper insights.\n\n\
Rules:\n\
- Combine related observations into broader patterns.\n\
- Only synthesize what is strongly supported by the observations below.\n\
- If nothing meaningfully connects, output nothing.\n\
- Output one insight per line, each prefixed with a bracketed category:\n\
  [preference] User prefers X over Y\n\
  [pattern] User tends to do X when Y\n\
  [goal] User is working toward X\n\
  [convention] User's convention for X is Y\n\
  [constraint] User cannot X because Y\n\
Output ONLY the lines, no preamble.";

const SYSTEM_PASS3: &str = "You are a reasoning engine. Below are synthesized patterns \
derived from conversations between the User and their AI agent. Find the deepest \
insights that connect these patterns.\n\n\
Rules:\n\
- Find meta-patterns that connect multiple patterns below.\n\
- Only derive what is strongly supported.\n\
- If nothing meaningfully connects, output nothing.\n\
- Output one insight per line, each prefixed with a bracketed category:\n\
  [preference] User prefers X over Y\n\
  [pattern] User tends to do X when Y\n\
  [goal] User is working toward X\n\
  [convention] User's convention for X is Y\n\
  [constraint] User cannot X because Y\n\
Output ONLY the lines, no preamble.";

/// Entry point from the chat loop. Reads the agent's dialectic config from
/// `db_agent_profiles`, counts assistant turns, and runs the pass only on the
/// cadence boundary. Safe to spawn; best-effort.
pub async fn maybe_run(pool: &DbPool, conv_id: Uuid, agent: String) {
    let profile: Option<AgentProfileRow> = sqlx::query_as(
        "SELECT * FROM db_agent_profiles WHERE agent = $1",
    )
    .bind(&agent)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    let cadence = profile
        .as_ref()
        .and_then(|p| p.dialectic_cadence)
        .filter(|c| *c > 0)
        .map(|c| c as i64)
        .unwrap_or(DEFAULT_CADENCE);

    let depth = profile
        .as_ref()
        .and_then(|p| p.dialectic_depth)
        .unwrap_or(1)
        .clamp(1, 3);

    let dialectic_model_id = profile
        .as_ref()
        .and_then(|p| p.dialectic_model_id.clone())
        .filter(|m| !m.trim().is_empty());

    let observe_vault = profile
        .as_ref()
        .and_then(|p| p.dialectic_observe_vault)
        .unwrap_or(false);

    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_chat_messages WHERE conversation_id = $1 AND role = 'assistant'",
    )
    .bind(conv_id)
    .fetch_one(pool)
    .await
    .unwrap_or(0);
    if count == 0 || count % cadence != 0 {
        return;
    }
    if let Err(e) = run(pool, conv_id, &agent, depth, dialectic_model_id.as_deref(), observe_vault).await {
        log::warn!("dialectic ({conv_id}): {e}");
    }
}

async fn run(
    pool: &DbPool,
    conv_id: Uuid,
    agent: &str,
    depth: i32,
    dialectic_model_id: Option<&str>,
    observe_vault: bool,
) -> Result<(), String> {
    // Resolve the model: use the per-agent override if set, otherwise the default.
    let model: ModelRow = if let Some(mid) = dialectic_model_id {
        sqlx::query_as("SELECT * FROM db_llm_models WHERE model_id = $1 AND enabled LIMIT 1")
            .bind(mid)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("dialectic model '{mid}' not found or disabled"))?
    } else {
        sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no default model")?
    };
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("provider not found")?;
    if !providers::supported(&provider.kind) || provider.api_key.trim().is_empty() {
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

    // ── Vault snapshot (opt-in) ──
    // When enabled, queries the vault for tasks, calendar, and notes to give
    // the dialectic model awareness beyond the conversation text. Heuristically
    // ranked + capped to ~500 chars to stay within token budget.
    let snapshot = if observe_vault {
        build_vault_snapshot(pool).await
    } else {
        String::new()
    };

    // ── Multi-pass loop ──
    // Pass 1: extract raw observations from the transcript (+ vault snapshot).
    // Pass 2+: feed previous pass results back for deeper synthesis.
    let mut prior = String::new();
    for pass in 1..=depth {
        let (system, user_content) = if pass == 1 {
            let mut conv_block = format!("Conversation:\n---\n{transcript}---");
            if !snapshot.is_empty() {
                conv_block.push_str(&format!("\n\n{}", snapshot));
            }
            (SYSTEM_PASS1, conv_block)
        } else if pass == 2 {
            (
                SYSTEM_PASS2,
                format!("Observations:\n---\n{prior}---"),
            )
        } else {
            (
                SYSTEM_PASS3,
                format!("Patterns to connect:\n---\n{prior}---"),
            )
        };

        let messages = vec![
            serde_json::json!({ "role": "system", "content": system }),
            serde_json::json!({ "role": "user", "content": user_content }),
        ];

        let raw = providers::complete(
            &provider.kind,
            &provider.api_key,
            provider.base_url.as_deref(),
            &model.model_id,
            &messages,
            8000,
        )
        .await?;

        log::info!(
            "dialectic ({conv_id}): pass {pass}/{depth} returned {} chars",
            raw.len(),
        );

        if pass == depth {
            // Final pass: save each insight.
            let insights = parse_insights(&raw);
            log::info!(
                "dialectic ({conv_id}): final pass parsed {} insight(s)",
                insights.len()
            );
            let mut saved = 0;
            for (category, content) in insights {
                match memory::save_derived(pool, agent, &content, Some(&category), Some(conv_id))
                    .await
                {
                    Ok("inserted") | Ok("corroborated") => saved += 1,
                    Ok(_) => {}
                    Err(e) => log::warn!("dialectic save ({conv_id}): {e}"),
                }
            }
            if saved > 0 {
                log::info!("dialectic ({conv_id}): saved {saved} derived insight(s)");
            }
        } else {
            // Intermediate pass: stash results for the next iteration.
            let insights = parse_insights(&raw);
            if insights.is_empty() {
                return Ok(());
            }
            prior = insights
                .iter()
                .map(|(cat, c)| format!("[{cat}] {c}"))
                .collect::<Vec<_>>()
                .join("\n");
            log::info!(
                "dialectic ({conv_id}): pass {pass} produced {} intermediate insight(s)",
                insights.len()
            );
        }
    }

    Ok(())
}

/// Build a ~500-char vault snapshot block for the dialectic prompt: tasks
/// (overdue/pending by bucket, sorted by count DESC), calendar (closest 3
/// upcoming events), and notes (3 most recently modified). Heuristic ranking
/// with tight caps — no embedding calls, no user_id filtering (single-user
/// vault). Returns empty string on any failure (best-effort).
async fn build_vault_snapshot(pool: &DbPool) -> String {
    let mut parts: Vec<String> = Vec::new();

    // ── Tasks: overdue/pending, grouped by bucket, top 3 buckets by count ──
    let task_rows: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT COALESCE(b.name, 'uncategorised'), COUNT(*) AS cnt \
         FROM db_tasks t LEFT JOIN db_buckets b ON t.bucket_id = b.id \
         WHERE t.done = FALSE \
           AND (t.due_at IS NULL OR t.due_at <= NOW() + INTERVAL '7 days') \
         GROUP BY b.name \
         ORDER BY cnt DESC, b.name \
         LIMIT 3",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if !task_rows.is_empty() {
        let items: Vec<String> = task_rows
            .iter()
            .map(|(bucket, cnt)| {
                if let Some(b) = bucket {
                    format!("{cnt} in \"{b}\"")
                } else {
                    format!("{cnt} uncategorised")
                }
            })
            .collect();
        parts.push(format!("Tasks: {}", items.join(", ")));
    }

    // ── Calendar: closest 3 upcoming events (next 7 days) ──
    let event_rows: Vec<(String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT title, starts_at FROM db_calendar_events \
         WHERE starts_at > NOW() AND starts_at < NOW() + INTERVAL '7 days' \
         ORDER BY starts_at LIMIT 3",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if !event_rows.is_empty() {
        let items: Vec<String> = event_rows
            .iter()
            .map(|(title, starts_at)| {
                let dt = starts_at.with_timezone(&chrono::Local);
                format!("\"{}\" {}", title, dt.format("%a %H:%M"))
            })
            .collect();
        parts.push(format!("Calendar: {}", items.join(" | ")));
    }

    // ── Notes: 3 most recently modified (not deleted) ──
    let note_rows: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT title, folder FROM notes \
         WHERE deleted_at IS NULL \
         ORDER BY updated_at DESC LIMIT 3",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if !note_rows.is_empty() {
        let items: Vec<String> = note_rows
            .iter()
            .map(|(title, folder)| {
                let path = folder.as_deref().unwrap_or("/");
                // Strip leading / for brevity; keep parent folder name only
                let short = path.trim_matches('/').rsplit('/').next().unwrap_or(path);
                if short.is_empty() || short == "/" {
                    format!("\"{title}\"")
                } else {
                    format!("\"{title}\" ({short})")
                }
            })
            .collect();
        parts.push(format!("Notes: {}", items.join(", ")));
    }

    if parts.is_empty() {
        return String::new();
    }

    let body = parts.join("\n");
    let block = format!("## Current Vault State\n{body}");

    // Hard cap at 500 chars — truncate the last part if needed.
    if block.len() <= 500 {
        block
    } else {
        let mut truncated = block.chars().take(497).collect::<String>();
        truncated.push_str("...");
        truncated
    }
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

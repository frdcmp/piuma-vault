//! Headless agent turn executor. Runs the same multi-round tool loop as the SSE
//! chat handler (`apps::agents::chat`) but with NO connected client — used by the
//! cron-worker to execute scheduled jobs. Reuses the same building blocks
//! (providers / tools / identities / registry / memory). It does not stream, so
//! provider deltas are discarded (the throwaway SSE channel's receiver is
//! dropped) and only the final `CallResult` per round is kept.
//!
//! This intentionally does NOT refactor `chat.rs` — keeping the live, delicate
//! SSE/cancel/inject path untouched. The two loops share every lower-level piece;
//! if they drift, fold the common core into here later.

use chrono::Utc;
use futures::channel::mpsc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::apps::embeddings;
use crate::db::db::DbPool;

use super::chat::blocks_to_text;
use super::models::{ConversationRow, ModelRow, ProviderRow};
use super::{identities, providers, registry, tools};

const MAX_ROUNDS: usize = 12;

pub struct RunOptions {
    /// IANA timezone the agent resolves relative dates in (e.g. "Europe/Rome").
    pub timezone: String,
    /// When false, `delete_*` tools are stripped from the enabled set so an
    /// unattended run can't destroy data unless the job opted in.
    pub allow_destructive: bool,
    /// Tag stored on the persisted user message metadata (e.g. "cron") so the UI
    /// can badge the turn as scheduled.
    pub source: String,
    /// When true, the turn runs with a CLEAN context: only this run's prompt is
    /// sent to the model — prior turns in the conversation are NOT replayed. The
    /// per-job conversation still records each run (for review), but a scheduled
    /// job is independent each time, so it shouldn't re-send (and pay for) days
    /// of stale history. The in-run tool rounds are unaffected.
    pub fresh_context: bool,
}

pub struct TurnResult {
    pub assistant_text: String,
    pub tools_used: Vec<String>,
    pub message_id: Option<Uuid>,
    pub tokens_in: i32,
    pub tokens_out: i32,
}

fn current_time_block(tz: &str) -> String {
    format!(
        "# Current time\nThe current UTC time is {}. The user's timezone is {tz} — interpret \
         relative dates like \"today\"/\"tomorrow\" in this timezone and emit RFC3339 timestamps \
         with the correct offset when calling tools.",
        Utc::now().to_rfc3339()
    )
}

/// Execute one scheduled agent turn into `conv_id`. Persists the user prompt and
/// the assistant reply (with tool_use/tool_result blocks) just like a chat turn,
/// logs token usage (`source='cron'`), and returns a summary of what happened.
pub async fn run_turn(
    pool: &DbPool,
    conv_id: Uuid,
    user_id: &str,
    prompt: &str,
    opts: RunOptions,
) -> Result<TurnResult, String> {
    let conv: ConversationRow =
        sqlx::query_as("SELECT * FROM db_chat_conversations WHERE id = $1")
            .bind(conv_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "conversation not found".to_string())?;

    // Resolve model + provider (conversation override or the global default).
    let model_row: ModelRow = match conv.model_id {
        Some(mid) => sqlx::query_as("SELECT * FROM db_llm_models WHERE id = $1")
            .bind(mid)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten(),
        None => sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten(),
    }
    .ok_or_else(|| "no model configured — add one in admin → Agents".to_string())?;

    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model_row.provider_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "provider not found".to_string())?;
    if !providers::supported(&provider.kind) {
        return Err(format!("provider kind '{}' is not supported", provider.kind));
    }
    let is_local = matches!(provider.kind.as_str(), "ollama" | "lmstudio");
    if provider.api_key.trim().is_empty() && !is_local {
        return Err("provider has no API key set".to_string());
    }

    let resolved = identities::resolve(pool, &conv.agent, &conv.identity).await?;

    // Enabled tools = agent subscription ∩ persona.allowed_tools, minus the
    // destructive `delete_*` family unless this job opted in.
    let enabled: Vec<String> = match registry::get(&conv.agent) {
        Some(def) => {
            let allowed = resolved.persona.allowed_tools.clone();
            def.tools
                .iter()
                .map(|s| s.to_string())
                .filter(|t| allowed.as_ref().map_or(true, |a| a.contains(t)))
                .filter(|t| opts.allow_destructive || !t.starts_with("delete_"))
                .collect()
        }
        None => Vec::new(),
    };
    let tool_schemas = tools::schemas_for(&enabled);

    // Persist the user (cron prompt) message, tagged so the UI can badge it.
    let user_content = json!([{ "type": "text", "text": prompt }]);
    let user_emb = embeddings::embed(pool, prompt, 1536, "embedding:chat").await.ok();
    let meta = json!({ "source": opts.source });
    let persisted = if let Some(ref emb) = user_emb {
        let pg_vec = pgvector::Vector::from(emb.clone());
        sqlx::query(
            "INSERT INTO db_chat_messages (conversation_id, role, content, content_text, embedding, metadata) \
             VALUES ($1, 'user', $2, $3, $4, $5)",
        )
        .bind(conv_id)
        .bind(&user_content)
        .bind(prompt)
        .bind(&pg_vec)
        .bind(&meta)
        .execute(pool)
        .await
    } else {
        sqlx::query(
            "INSERT INTO db_chat_messages (conversation_id, role, content, content_text, metadata) \
             VALUES ($1, 'user', $2, $3, $4)",
        )
        .bind(conv_id)
        .bind(&user_content)
        .bind(prompt)
        .bind(&meta)
        .execute(pool)
        .await
    };
    persisted.map_err(|e| e.to_string())?;

    // Build OpenAI-shaped messages: system + capped history (history already
    // includes the prompt we just persisted, so it's the latest user turn).
    let mut messages: Vec<Value> = Vec::new();
    let mut blocks = vec![
        current_time_block(&opts.timezone),
        format!(
            "# Your model\nYou are running on \"{}\" (provider: {}, API model id: {}).",
            model_row.display_name, provider.kind, model_row.model_id
        ),
    ];
    if !resolved.system_prompt.trim().is_empty() {
        blocks.push(resolved.system_prompt.clone());
    }
    let retrieved =
        tools::memory::retrieve_for_turn(pool, &conv.agent, user_emb.as_ref(), prompt, 5).await;
    let mem_block = tools::memory::format_block(&retrieved);
    if !mem_block.trim().is_empty() {
        blocks.push(mem_block);
    }
    let system = blocks.join("\n\n");
    if !system.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": system }));
    }

    if opts.fresh_context {
        // Stateless run: ignore the conversation's prior turns entirely — send
        // only this run's prompt. (It's already persisted above for the record.)
        messages.push(json!({ "role": "user", "content": prompt }));
    } else {
        let rows: Vec<(String, Value)> = sqlx::query_as(
            "SELECT role, content FROM db_chat_messages WHERE conversation_id = $1 ORDER BY created_at",
        )
        .bind(conv_id)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
        let mut hist: Vec<(String, String)> = rows
            .into_iter()
            .filter(|(role, _)| role == "user" || role == "assistant")
            .map(|(role, content)| (role, blocks_to_text(&content)))
            .filter(|(_, text)| !text.trim().is_empty())
            .collect();
        if hist.len() > 50 {
            hist.drain(..hist.len() - 50);
        }
        for (role, text) in hist {
            messages.push(json!({ "role": role, "content": text }));
        }
    }

    // Throwaway SSE sink: providers want a sender, but headless runs only need
    // the accumulated CallResult. Dropping the receiver makes every send a no-op.
    let (tx, rx) = mpsc::unbounded::<Result<bytes::Bytes, actix_web::Error>>();
    drop(rx);

    let mut display: Vec<Value> = Vec::new();
    let mut tools_used: Vec<String> = Vec::new();
    let mut tin = 0;
    let mut tout = 0;
    let mut tcached = 0;
    let mut tcache_write = 0;
    let mut answered = false;

    for _round in 0..MAX_ROUNDS {
        let res = providers::call(
            &provider.kind,
            &provider.api_key,
            provider.base_url.as_deref(),
            &model_row.model_id,
            &messages,
            &tool_schemas,
            &tx,
        )
        .await?;
        tin += res.tokens_in;
        tout += res.tokens_out;
        tcached += res.tokens_cached;
        tcache_write += res.tokens_cache_write;
        if !res.thinking.trim().is_empty() {
            display.push(json!({ "type": "thinking", "text": res.thinking }));
        }
        if res.tool_calls.is_empty() {
            if !res.text.trim().is_empty() {
                display.push(json!({ "type": "text", "text": res.text }));
            }
            answered = true;
            break;
        }
        let tcs: Vec<Value> = res
            .tool_calls
            .iter()
            // `thought_signature` MUST be echoed back: Gemini 3 requires the
            // signature it returned on a tool call to ride the same call when it's
            // replayed in history, else the next round 400s. (chat.rs does the
            // same; run_turn previously dropped it, breaking Gemini cron jobs.)
            .map(|t| json!({ "id": t.id, "type": "function", "function": { "name": t.name, "arguments": t.arguments }, "thought_signature": t.thought_signature }))
            .collect();
        messages.push(json!({
            "role": "assistant",
            "content": if res.text.is_empty() { Value::Null } else { Value::String(res.text.clone()) },
            "tool_calls": tcs,
        }));
        if !res.text.trim().is_empty() {
            display.push(json!({ "type": "text", "text": res.text }));
        }
        for tc in &res.tool_calls {
            let args: Value = serde_json::from_str(&tc.arguments).unwrap_or_else(|_| json!({}));
            display.push(json!({ "type": "tool_use", "name": tc.name, "input": args.clone() }));
            tools_used.push(tc.name.clone());
            let result = match tools::dispatch(pool, user_id, &conv.agent, &tc.name, &args).await {
                Ok(v) => v,
                Err(e) => json!({ "error": e }),
            };
            display.push(json!({ "type": "tool_result", "name": tc.name, "output": result.clone() }));
            let content_str = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
            messages.push(json!({ "role": "tool", "tool_call_id": tc.id, "content": content_str }));
        }
    }

    // Out of rounds while still wanting tools — one final tool-less synthesis.
    if !answered {
        messages.push(json!({
            "role": "user",
            "content": "You've reached the tool-call limit for this turn. Answer now using the \
                        information you've already gathered — do not request more tools.",
        }));
        if let Ok(res) = providers::call(
            &provider.kind,
            &provider.api_key,
            provider.base_url.as_deref(),
            &model_row.model_id,
            &messages,
            &[],
            &tx,
        )
        .await
        {
            tin += res.tokens_in;
            tout += res.tokens_out;
            if !res.text.trim().is_empty() {
                display.push(json!({ "type": "text", "text": res.text }));
            }
        }
    }

    let content = Value::Array(display);
    let assistant_text = blocks_to_text(&content);
    let msg_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO db_chat_messages \
           (conversation_id, role, content, content_text, model_used, provider_kind, \
            tokens_input, tokens_output, tokens_cached, stop_reason) \
         VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7, $8, 'end_turn') RETURNING id",
    )
    .bind(conv_id)
    .bind(&content)
    .bind(&assistant_text)
    .bind(&model_row.model_id)
    .bind(&provider.kind)
    .bind(tin)
    .bind(tout)
    .bind(tcached)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();

    if tin + tout + tcached + tcache_write > 0 {
        let _ = sqlx::query(
            "INSERT INTO db_token_usage \
               (kind, source, provider_kind, model, tokens_input, tokens_output, tokens_cached, tokens_cache_write, conversation_id) \
             VALUES ('chat', 'cron', $1, $2, $3, $4, $5, $6, $7)",
        )
        .bind(&provider.kind)
        .bind(&model_row.model_id)
        .bind(tin)
        .bind(tout)
        .bind(tcached)
        .bind(tcache_write)
        .bind(conv_id)
        .execute(pool)
        .await;
    }
    let _ = sqlx::query("UPDATE db_chat_conversations SET updated_at = NOW() WHERE id = $1")
        .bind(conv_id)
        .execute(pool)
        .await;

    tools_used.sort();
    tools_used.dedup();
    Ok(TurnResult {
        assistant_text,
        tools_used,
        message_id: msg_id,
        tokens_in: tin,
        tokens_out: tout,
    })
}

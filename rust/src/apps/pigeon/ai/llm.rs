//! The model Pigeon writes with: one of the vault's own (admin → Agents), the one picked for
//! Pigeon (`app_settings` pigeon_model_id) or else the default. Two ways: plain text (a summary,
//! a style profile) and tool calls (the agent proposing actions). No streaming: nobody watches
//! it type. Each call's tokens go to the usage ledger as `pigeon`, and how long it took to
//! telemetry (`llm` events, route `pigeon`, the event's type what it wrote: draft, reply, memory,
//! style…): no words, only the model, the tokens and the time.

use futures::channel::mpsc;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::agents::models::{ModelRow, ProviderRow};
use crate::apps::agents::providers;
use crate::apps::settings::store;
use crate::apps::telemetry::{Event, Severity};
use crate::db::db::DbPool;

/// The `app_settings` key naming the model Pigeon uses (a `db_llm_models` id).
pub const MODEL_SETTING: &str = "pigeon_model_id";
/// The model replies are written with, drafts and auto replies (they speak as the user); unset:
/// `MODEL_SETTING`'s.
pub const REPLY_MODEL_SETTING: &str = "pigeon_reply_model_id";

/// What a model call writes: a reply as the user, or the rest (tasks, summaries, what Pigeon
/// learns about people).
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Writer {
    Reply,
    Other,
}

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
    resolve_for(pool, Writer::Other).await
}

async fn resolve_for(pool: &DbPool, writer: Writer) -> anyhow::Result<Resolved> {
    let reply_model: Option<Uuid> = match writer {
        Writer::Reply => store::get(pool, REPLY_MODEL_SETTING).await.and_then(|v| v.parse().ok()),
        Writer::Other => None,
    };
    let picked: Option<Uuid> = match reply_model {
        Some(m) => Some(m),
        None => store::get(pool, MODEL_SETTING).await.and_then(|v| v.parse().ok()),
    };
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
    complete_as(pool, Writer::Other, system, user, tools).await
}

/// The same, with the model for what it writes (`Writer::Reply`: the replies model).
pub async fn complete_as(pool: &DbPool, writer: Writer, system: &str, user: &str, tools: &[Json]) -> anyhow::Result<Reply> {
    complete_for(pool, writer, if writer == Writer::Reply { "reply" } else { "other" }, system, user, tools).await
}

/// The same, named in telemetry by what it writes (`what`).
async fn complete_for(pool: &DbPool, writer: Writer, what: &str, system: &str, user: &str, tools: &[Json]) -> anyhow::Result<Reply> {
    let r = resolve_for(pool, writer).await?;
    let messages = [json!({ "role": "system", "content": system }), json!({ "role": "user", "content": user })];
    let res = call(pool, &r, &messages, tools, "pigeon", what).await?;
    Ok(reply_of(res))
}

/// The vault's tools the drafter may read with (Piuma's own, read-only: notes, tasks, the
/// calendar, the agenda). Nothing that writes, and nothing the auto responder ever gets.
pub const VAULT_READS: &[&str] = &["search_notes", "read_note", "browse_folder", "list_tasks", "get_task", "list_events", "get_event", "get_agenda"];
/// Rounds of looking things up before the drafter must write.
const READ_ROUNDS: usize = 6;

/// The drafter's turn: like `complete`, and the model may first look things up in the user's vault
/// (`VAULT_READS`, run as `user`), a few rounds, before it calls one of `tools`. Its reads are
/// logged; any other tool it names that isn't in `tools` is refused.
pub async fn complete_reading(pool: &DbPool, user_id: &str, system: &str, user: &str, tools: &[Json]) -> anyhow::Result<Reply> {
    let r = resolve_for(pool, Writer::Reply).await?;
    let reads: Vec<String> = VAULT_READS.iter().map(|s| s.to_string()).collect();
    let mut all: Vec<Json> = tools.to_vec();
    all.extend(crate::apps::agents::tools::schemas_for(&reads));
    let mut messages = vec![json!({ "role": "system", "content": system }), json!({ "role": "user", "content": user })];
    for round in 0..=READ_ROUNDS {
        // the last round: only the actions, it writes now
        let offered: &[Json] = if round == READ_ROUNDS { tools } else { &all };
        let res = call(pool, &r, &messages, offered, "pigeon-draft", "draft").await?;
        let reading: Vec<&providers::ToolCall> = res.tool_calls.iter().filter(|c| VAULT_READS.contains(&c.name.as_str())).collect();
        if reading.is_empty() {
            return Ok(reply_of(res));
        }
        messages.push(json!({
            "role": "assistant",
            "content": if res.text.is_empty() { Json::Null } else { Json::String(res.text.clone()) },
            "tool_calls": res.tool_calls.iter().map(|t| json!({ "id": t.id, "type": "function", "function": { "name": t.name, "arguments": t.arguments }, "thought_signature": t.thought_signature })).collect::<Vec<_>>(),
        }));
        for c in &res.tool_calls {
            let args: Json = serde_json::from_str(&c.arguments).unwrap_or_else(|_| json!({}));
            let out = if VAULT_READS.contains(&c.name.as_str()) {
                log::info!("pigeon draft: reads {} {}", c.name, crate::apps::pigeon::conversations::clip(&args.to_string(), 120));
                crate::apps::agents::tools::vault_read(pool, user_id, &c.name, &args).await.unwrap_or_else(|e| json!({ "error": e }))
            } else {
                // an action alongside reads: not yet, it writes once it has read
                json!({ "error": "not done: read first, then call it again" })
            };
            messages.push(json!({ "role": "tool", "tool_call_id": c.id, "content": serde_json::to_string(&out).unwrap_or_default() }));
        }
    }
    anyhow::bail!("the drafter kept reading and wrote nothing")
}

/// One call to the model, its tokens to the usage ledger under `source`, its time to telemetry
/// as `what`.
async fn call(pool: &DbPool, r: &Resolved, messages: &[Json], tools: &[Json], source: &str, what: &str) -> anyhow::Result<providers::CallResult> {
    // nobody streams it: the deltas go nowhere
    let (tx, _rx) = mpsc::unbounded();
    let started = std::time::Instant::now();
    let res = providers::call(&r.kind, &r.api_key, r.base_url.as_deref(), &r.model, messages, tools, &tx).await;
    let took = started.elapsed().as_millis().min(u32::MAX as u128) as u32;
    let event = |severity| Event::new("llm", what, severity).route("pigeon").model(&r.model).duration(took);
    let res = match res {
        Ok(res) => {
            event(Severity::Info)
                .tokens(res.tokens_in.max(0) as u32, res.tokens_out.max(0) as u32)
                .attrs(json!({ "provider": r.kind, "tokens_cached": res.tokens_cached }))
                .emit();
            res
        }
        Err(e) => {
            event(Severity::Error).error_code("model_refused").attrs(json!({ "provider": r.kind })).emit();
            anyhow::bail!("the model refused: {e}");
        }
    };
    if res.tokens_in + res.tokens_out > 0 {
        let _ = sqlx::query(
            "INSERT INTO db_token_usage (kind, source, provider_kind, model, tokens_input, tokens_output, tokens_cached, tokens_cache_write)
             VALUES ('chat', $7, $1, $2, $3, $4, $5, $6)",
        )
        .bind(&r.kind)
        .bind(&r.model)
        .bind(res.tokens_in)
        .bind(res.tokens_out)
        .bind(res.tokens_cached)
        .bind(res.tokens_cache_write)
        .bind(source)
        .execute(pool)
        .await;
    }
    Ok(res)
}

fn reply_of(res: providers::CallResult) -> Reply {
    let tool_calls = res
        .tool_calls
        .into_iter()
        .map(|c| ToolCall { args: serde_json::from_str(&c.arguments).unwrap_or_else(|_| json!({})), name: c.name })
        .collect();
    Reply { text: res.text, tool_calls }
}

/// Plain text, no tools.
pub async fn text(pool: &DbPool, system: &str, user: &str) -> anyhow::Result<String> {
    text_of(pool, "other", system, user).await
}

/// The same, named in telemetry by what it writes (`what`: memory, style, summary).
pub async fn text_of(pool: &DbPool, what: &str, system: &str, user: &str) -> anyhow::Result<String> {
    Ok(complete_for(pool, Writer::Other, what, system, user, &[]).await?.text.trim().to_string())
}

/// Whether a model is there to write with.
pub async fn available(pool: &DbPool) -> bool {
    resolve(pool).await.is_ok()
}

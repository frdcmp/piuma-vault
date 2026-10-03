//! Voice-agent HTTP API. Audio never passes through here: the client talks to
//! the speech-to-speech provider directly with a short-lived token minted by
//! `start_session`. The backend still owns everything that matters — the system
//! instruction and tool list (locked into the token), executing every tool call
//! (`run_tool`), and persisting the conversation (`save_turn`).

use std::time::Instant;

use actix_web::{web, HttpResponse, Responder};
use serde_json::{json, Value};
use uuid::Uuid;

use super::models::{StartSessionReq, StartSessionResp, ToolReq, TurnReq};
use super::{config, prompt, providers};
use crate::apps::agents::chat::{blocks_to_text, current_time_context, publish_tool_event};
use crate::apps::agents::models::ConversationRow;
use crate::apps::agents::{dialectic, identities, registry, tools};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::calendar::events::CalendarEventBus;
use crate::apps::notes::events::NotesEventBus;
use crate::apps::settings::store;
use crate::apps::tasks::events::TasksEventBus;
use crate::apps::telemetry::{Event, Severity};
use crate::db::db::DbPool;

/// The agent that answers by voice.
const VOICE_AGENT: &str = "vault_agent";
/// Characters of a tool call's arguments kept in telemetry.
const ARGS_PREVIEW: usize = 500;

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(json!({ "error": "admin_access required" }))
}

fn bad_request(msg: impl Into<String>) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({ "error": msg.into() }))
}

fn db_error(e: sqlx::Error) -> HttpResponse {
    log::error!("voice: db error: {e}");
    HttpResponse::InternalServerError().json(json!({ "error": "database error" }))
}

async fn load_conversation(pool: &DbPool, id: Uuid) -> Result<Option<ConversationRow>, sqlx::Error> {
    sqlx::query_as("SELECT * FROM db_chat_conversations WHERE id = $1")
        .bind(id)
        .fetch_optional(pool)
        .await
}

/// Voice tools this conversation may use: the voice subset ∩ the agent's
/// subscription ∩ the persona's `allowed_tools`.
async fn enabled_tools(pool: &DbPool, conv: &ConversationRow) -> Result<Vec<String>, String> {
    let def = registry::get(&conv.agent).ok_or("unknown agent")?;
    let resolved = identities::resolve(pool, &conv.agent, &conv.identity).await?;
    let allowed = resolved.persona.allowed_tools;
    Ok(prompt::VOICE_TOOLS
        .iter()
        .filter(|t| def.tools.contains(t))
        .filter(|t| tools::tool_allowed(allowed.as_ref(), t))
        .map(|t| t.to_string())
        .collect())
}

/// A voice telemetry event for `user`.
fn event(user: &AuthenticatedUser, event_type: &str, severity: Severity) -> Event {
    Event::new("voice", event_type, severity).user(user)
}

/// POST /agents/voice/sessions — mint a provider session for a new or existing
/// voice conversation.
pub async fn start_session(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<StartSessionReq>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let req = body.into_inner();
    let started = Instant::now();

    let cfg = match config::resolve_with(pool, None, None, None).await {
        Ok(c) => c,
        Err(e) => {
            event(&user, "session_error", Severity::Error).msg(&e).emit();
            return bad_request(e);
        }
    };
    let voice = match cfg.kind.as_str() {
        "gemini" => store::get(pool, store::VOICE_GEMINI_VOICE).await,
        _ => None,
    };

    let conv = match req.conversation_id {
        Some(id) => match load_conversation(pool, id).await {
            Ok(Some(c)) => c,
            Ok(None) => return bad_request("conversation not found"),
            Err(e) => return db_error(e),
        },
        None => {
            let Some(def) = registry::get(VOICE_AGENT) else {
                return bad_request("voice agent not registered");
            };
            let created = sqlx::query_as::<_, ConversationRow>(
                "INSERT INTO db_chat_conversations (agent, title, model_id, identity, metadata) \
                 VALUES ($1, $2, (SELECT id FROM db_llm_models WHERE is_default AND enabled LIMIT 1), $3, $4) \
                 RETURNING *",
            )
            .bind(def.kind)
            .bind("🎙 Voice")
            .bind(def.persona)
            .bind(json!({ "source": "voice" }))
            .fetch_one(pool)
            .await;
            match created {
                Ok(c) => c,
                Err(e) => return db_error(e),
            }
        }
    };

    let resolved = match identities::resolve(pool, &conv.agent, &conv.identity).await {
        Ok(r) => r,
        Err(e) => return bad_request(e),
    };
    let enabled = match enabled_tools(pool, &conv).await {
        Ok(t) => t,
        Err(e) => return bad_request(e),
    };
    let schemas = tools::schemas_for(&enabled);

    let mut blocks = vec![current_time_context(
        req.timezone.as_deref(),
        req.client_now.as_deref(),
    )];
    if !resolved.system_prompt.trim().is_empty() {
        blocks.push(resolved.system_prompt.clone());
    }
    blocks.push(prompt::voice_block());
    let history = prompt::history_block(pool, conv.id).await;
    if !history.is_empty() {
        blocks.push(history);
    }
    let system = blocks.join("\n\n");

    let spec = providers::SessionSpec {
        model: &cfg.model,
        voice: voice.as_deref(),
        system: &system,
        tools: &schemas,
        resume_handle: req.resume_handle.as_deref(),
    };
    let resumed = req.resume_handle.is_some();
    match providers::start_session(&cfg.kind, &cfg.api_key, &spec).await {
        Ok(session) => {
            event(&user, "session_start", Severity::Info)
                .entity("conversation", conv.id)
                .model(&cfg.model)
                .duration(started.elapsed().as_millis() as u32)
                .attrs(json!({
                    "provider": cfg.kind,
                    "voice": voice,
                    "tools": enabled.len(),
                    "system_chars": system.chars().count(),
                    "resumed": resumed,
                    "continued": req.conversation_id.is_some(),
                }))
                .emit();
            HttpResponse::Ok().json(StartSessionResp {
            conversation_id: conv.id,
            provider: cfg.kind,
            model: cfg.model,
            ws_url: session.ws_url,
            setup: session.setup,
            })
        }
        Err(e) => {
            log::error!("voice: start session: {e}");
            event(&user, "session_error", Severity::Error)
                .entity("conversation", conv.id)
                .model(&cfg.model)
                .msg(&e)
                .attrs(json!({ "provider": cfg.kind, "resumed": resumed }))
                .emit();
            HttpResponse::BadGateway().json(json!({ "error": e }))
        }
    }
}

/// POST /agents/voice/tool — run one tool call the model made. Only tools in
/// the conversation's voice set are allowed.
pub async fn run_tool(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<ToolReq>,
    notes_bus: web::Data<NotesEventBus>,
    tasks_bus: web::Data<TasksEventBus>,
    calendar_bus: web::Data<CalendarEventBus>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let req = body.into_inner();
    let conv = match load_conversation(pool, req.conversation_id).await {
        Ok(Some(c)) => c,
        Ok(None) => return bad_request("conversation not found"),
        Err(e) => return db_error(e),
    };
    let enabled = match enabled_tools(pool, &conv).await {
        Ok(t) => t,
        Err(e) => return bad_request(e),
    };
    if !enabled.contains(&req.name) {
        event(&user, "tool_call", Severity::Warn)
            .entity("conversation", conv.id)
            .msg(format!("tool `{}` is not available by voice", req.name))
            .attrs(json!({ "tool": req.name, "ok": false, "rejected": true }))
            .emit();
        return HttpResponse::Ok().json(json!({
            "ok": false,
            "result": { "error": format!("tool `{}` is not available by voice", req.name) },
        }));
    }
    let args = if req.args.is_object() { req.args } else { json!({}) };
    let started = Instant::now();
    let result = match tools::dispatch(pool, &user.user_id, &conv.agent, &req.name, &args).await {
        Ok(v) => v,
        Err(e) => json!({ "error": e }),
    };
    let ok = result.get("error").is_none();
    if ok {
        publish_tool_event(&req.name, &result, &notes_bus, &tasks_bus, &calendar_bus);
    }
    let mut ev = event(&user, "tool_call", if ok { Severity::Info } else { Severity::Warn })
        .entity("conversation", conv.id)
        .duration(started.elapsed().as_millis() as u32)
        .attrs(json!({
            "tool": req.name,
            "ok": ok,
            // Args can carry note bodies; keep only a short preview.
            "args": args.to_string().chars().take(ARGS_PREVIEW).collect::<String>(),
            "result_count": result.get("count"),
        }));
    if let Some(err) = result.get("error").and_then(|e| e.as_str()) {
        ev = ev.msg(err);
    }
    ev.emit();
    let label = result.get("title").and_then(|t| t.as_str()).map(str::to_string);
    HttpResponse::Ok().json(json!({ "ok": ok, "label": label, "result": result }))
}

/// POST /agents/voice/turns — persist one spoken turn on the conversation's
/// active branch, so voice chats read like any other chat in the dock.
pub async fn save_turn(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<TurnReq>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let req = body.into_inner();
    if req.role != "user" && req.role != "assistant" {
        return bad_request("role must be user or assistant");
    }
    let text = req.text.trim().to_string();
    if text.is_empty() && req.tools.is_empty() {
        return bad_request("empty turn");
    }
    let conv = match load_conversation(pool, req.conversation_id).await {
        Ok(Some(c)) => c,
        Ok(None) => return bad_request("conversation not found"),
        Err(e) => return db_error(e),
    };

    let mut blocks: Vec<Value> = Vec::new();
    for t in &req.tools {
        blocks.push(json!({ "type": "tool_use", "name": t.name, "input": t.input }));
        blocks.push(json!({ "type": "tool_result", "name": t.name, "output": t.output }));
    }
    if !text.is_empty() {
        blocks.push(json!({ "type": "text", "text": text }));
    }
    let content = Value::Array(blocks);
    let content_text = blocks_to_text(&content);
    let metadata = json!({ "source": "voice", "interrupted": req.interrupted });
    // User turns are embedded for L2/L3 retrieval, as in the text chat.
    let embedding = if req.role == "user" {
        crate::apps::embeddings::embed(pool, &content_text, 1536, "embedding:chat")
            .await
            .ok()
            .map(pgvector::Vector::from)
    } else {
        None
    };
    let stop_reason = (req.role == "assistant")
        .then(|| if req.interrupted { "interrupted" } else { "end_turn" });

    let inserted = sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO db_chat_messages \
           (conversation_id, parent_id, role, content, content_text, embedding, metadata, stop_reason) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(conv.id)
    .bind(conv.active_leaf_id)
    .bind(&req.role)
    .bind(&content)
    .bind(&content_text)
    .bind(embedding)
    .bind(&metadata)
    .bind(stop_reason)
    .fetch_one(pool)
    .await;
    let msg_id = match inserted {
        Ok(id) => id,
        Err(e) => return db_error(e),
    };
    if let Err(e) = sqlx::query(
        "UPDATE db_chat_conversations SET active_leaf_id = $2, updated_at = NOW() WHERE id = $1",
    )
    .bind(conv.id)
    .bind(msg_id)
    .execute(pool)
    .await
    {
        return db_error(e);
    }

    // Assistant turns carry the provider's token usage → the Token Usage ledger.
    let model = config::resolve_with(pool, None, None, None).await.ok();
    let tin = req.tokens_input.unwrap_or(0).max(0);
    let tout = req.tokens_output.unwrap_or(0).max(0);
    let tin_audio = req.tokens_input_audio.unwrap_or(0).clamp(0, tin);
    let tout_audio = req.tokens_output_audio.unwrap_or(0).clamp(0, tout);
    if req.role == "assistant" && tin + tout > 0 {
        if let Some(cfg) = &model {
            let _ = sqlx::query(
                "INSERT INTO db_token_usage \
                   (kind, source, provider_kind, model, tokens_input, tokens_output, \
                    tokens_input_audio, tokens_output_audio, conversation_id) \
                 VALUES ('chat', 'voice', $1, $2, $3, $4, $5, $6, $7)",
            )
            .bind(&cfg.kind)
            .bind(&cfg.model)
            .bind(tin)
            .bind(tout)
            .bind(tin_audio)
            .bind(tout_audio)
            .bind(conv.id)
            .execute(pool)
            .await;
        }
    }
    let mut ev = event(&user, "turn", Severity::Info)
        .entity("conversation", conv.id)
        .tokens(tin as u32, tout as u32)
        .attrs(json!({
            "role": req.role,
            "chars": content_text.chars().count(),
            "tools": req.tools.iter().map(|t| t.name.as_str()).collect::<Vec<_>>(),
            "interrupted": req.interrupted,
            "latency_ms": req.latency_ms,
            "tokens_input_audio": tin_audio,
            "tokens_output_audio": tout_audio,
        }));
    if let Some(cfg) = &model {
        ev = ev.model(&cfg.model);
    }
    if let Some(ms) = req.latency_ms {
        ev = ev.duration(ms);
    }
    ev.emit();

    // L4: the dialectic pass runs on its cadence after assistant turns, as in chat.
    if req.role == "assistant" {
        let dpool = pool.clone();
        let agent = conv.agent.clone();
        let conv_id = conv.id;
        actix_web::rt::spawn(async move {
            dialectic::maybe_run(&dpool, conv_id, agent).await;
        });
    }

    HttpResponse::Ok().json(json!({ "message_id": msg_id }))
}

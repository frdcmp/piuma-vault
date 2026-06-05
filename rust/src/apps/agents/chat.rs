//! Streaming chat turn (SSE) with a multi-round tool loop. Resolves the
//! conversation's agent/identity/model, assembles the system prompt, persists
//! the user message, then loops: stream a DeepSeek round → if it emits
//! tool_calls, run them (under the user) and feed results back → repeat until
//! the model answers. The full turn (thinking / tool_use / tool_result / text
//! blocks) is persisted. DeepSeek-only for now.

use actix_web::{web, HttpResponse, Responder};
use bytes::Bytes;
use futures::channel::mpsc;
use serde_json::{json, Value};
use uuid::Uuid;

use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::settings;
use crate::db::db::DbPool;

use super::models::{ApiError, ChatTurnReq, ConversationRow, ModelRow, ProviderRow};
use super::providers::{deepseek, openclaw as oc_gateway};
use super::{identities, registry, tools};

const MAX_ROUNDS: usize = 8;

fn blocks_to_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

fn frame(payload: Value) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

/// Build a context preamble from the user's attached notes (the "locked" chips).
async fn build_context(pool: &DbPool, user_id: &str, ids: &[Uuid]) -> String {
    if ids.is_empty() {
        return String::new();
    }
    let rows: Vec<(String, String, String)> = sqlx::query_as(
        "SELECT title, COALESCE(folder, '/'), content FROM notes \
         WHERE id = ANY($1) AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(ids)
    .bind(user_id)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    if rows.is_empty() {
        return String::new();
    }
    let mut s = String::from("The user attached these notes as context:\n\n");
    for (title, folder, content) in rows {
        s.push_str(&format!("## {title} ({folder})\n{content}\n\n"));
    }
    s
}

/// Prepend the context block to the latest (user) message sent to the model —
/// the persisted user message stays raw, so the transcript shows what was typed.
fn inject_context(messages: &mut [Value], context: &str) {
    if context.is_empty() {
        return;
    }
    if let Some(last) = messages.last_mut() {
        let orig = last.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
        last["content"] = json!(format!("{context}\n{orig}"));
    }
}

pub async fn chat(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<ChatTurnReq>,
) -> impl Responder {
    let conv_id = path.into_inner();
    let req = body.into_inner();
    let msg = req.message;
    let context_ids = req.context_note_ids;
    let db = pool.get_ref();

    let conv = match sqlx::query_as::<_, ConversationRow>("SELECT * FROM db_chat_conversations WHERE id = $1")
        .bind(conv_id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(c)) => c,
        Ok(None) => return HttpResponse::NotFound().json(ApiError::new("conversation not found")),
        Err(e) => {
            log::error!("chat: load conv: {e}");
            return HttpResponse::InternalServerError().json(ApiError::new("database error"));
        }
    };

    // Gateway agents (e.g. OpenClaw) proxy to their external service instead of
    // running the native provider loop.
    let is_gateway = registry::get(&conv.agent)
        .map(|d| d.agent_type == registry::AgentType::Gateway)
        .unwrap_or(false);
    if is_gateway {
        return gateway_turn(db.clone(), user.user_id.clone(), conv, msg, context_ids).await;
    }

    let model_row: Option<ModelRow> = match conv.model_id {
        Some(mid) => sqlx::query_as("SELECT * FROM db_llm_models WHERE id = $1")
            .bind(mid)
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
        None => sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(db)
            .await
            .ok()
            .flatten(),
    };
    let Some(model_row) = model_row else {
        return HttpResponse::BadRequest().json(ApiError::new("no model configured — add one in admin → Agents"));
    };

    let provider: ProviderRow = match sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model_row.provider_id)
        .fetch_optional(db)
        .await
    {
        Ok(Some(p)) => p,
        _ => return HttpResponse::BadRequest().json(ApiError::new("provider not found")),
    };
    if provider.kind != "deepseek" {
        return HttpResponse::BadRequest().json(ApiError::new("only the deepseek provider is supported for now"));
    }
    if provider.api_key.trim().is_empty() {
        return HttpResponse::BadRequest().json(ApiError::new("provider has no API key set"));
    }

    let resolved = match identities::resolve(db, &conv.agent, &conv.identity).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::BadRequest().json(ApiError::new(e)),
    };

    // Enabled tools = agent subscription ∩ persona.allowed_tools (None = all);
    // schemas_for further narrows to the tools actually implemented.
    let enabled: Vec<String> = match registry::get(&conv.agent) {
        Some(def) => {
            let allowed = resolved.persona.allowed_tools.clone();
            def.tools
                .iter()
                .map(|s| s.to_string())
                .filter(|t| allowed.as_ref().map_or(true, |a| a.contains(t)))
                .collect()
        }
        None => Vec::new(),
    };
    let tool_schemas = tools::schemas_for(&enabled);

    // Persist user message + set a title on the first turn.
    let user_content = json!([{ "type": "text", "text": msg }]);
    if let Err(e) = sqlx::query("INSERT INTO db_chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)")
        .bind(conv_id)
        .bind(&user_content)
        .execute(db)
        .await
    {
        log::error!("chat: persist user msg: {e}");
        return HttpResponse::InternalServerError().json(ApiError::new("database error"));
    }
    if conv.title.as_deref().unwrap_or("").is_empty() {
        let title: String = msg.chars().take(60).collect();
        let _ = sqlx::query("UPDATE db_chat_conversations SET title = $2 WHERE id = $1")
            .bind(conv_id)
            .bind(&title)
            .execute(db)
            .await;
    }

    // Build OpenAI-shaped messages: system + capped history.
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT role, content FROM db_chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(conv_id)
    .fetch_all(db)
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
    let mut messages: Vec<Value> = Vec::with_capacity(hist.len() + 1);
    if !resolved.system_prompt.trim().is_empty() {
        messages.push(json!({ "role": "system", "content": resolved.system_prompt }));
    }
    for (role, text) in hist {
        messages.push(json!({ "role": role, "content": text }));
    }
    let context = build_context(db, &user.user_id, &context_ids).await;
    inject_context(&mut messages, &context);

    // ── Stream + tool loop ──
    let (tx, rx) = mpsc::unbounded::<Result<Bytes, actix_web::Error>>();
    let pool2 = db.clone();
    let user_id = user.user_id.clone();
    let model_label = model_row.model_id.clone();
    let provider_kind = provider.kind.clone();
    let api_key = provider.api_key.clone();
    let base_url = provider.base_url.clone();
    let model = model_row.model_id.clone();

    actix_web::rt::spawn(async move {
        let mut display: Vec<Value> = Vec::new();
        let mut tin = 0;
        let mut tout = 0;
        let mut stop = "end_turn".to_string();
        let mut errored = false;

        for _round in 0..MAX_ROUNDS {
            match deepseek::call(&api_key, base_url.as_deref(), &model, &messages, &tool_schemas, &tx).await {
                Ok(res) => {
                    tin += res.tokens_in;
                    tout += res.tokens_out;
                    stop = res.finish.clone();
                    if !res.thinking.trim().is_empty() {
                        display.push(json!({ "type": "thinking", "text": res.thinking }));
                    }
                    if res.tool_calls.is_empty() {
                        if !res.text.trim().is_empty() {
                            display.push(json!({ "type": "text", "text": res.text }));
                        }
                        break;
                    }
                    // Assistant turn that requested tools.
                    let tcs: Vec<Value> = res
                        .tool_calls
                        .iter()
                        .map(|t| json!({ "id": t.id, "type": "function", "function": { "name": t.name, "arguments": t.arguments } }))
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
                        // Announce the tool (with its args) so the client can show it
                        // live, then signal completion once it has run.
                        let _ = tx.unbounded_send(Ok(frame(
                            json!({ "type": "tool", "id": tc.id, "name": tc.name, "args": args.clone() }),
                        )));
                        display.push(json!({ "type": "tool_use", "name": tc.name, "input": args.clone() }));
                        let result = match tools::dispatch(&pool2, &user_id, &tc.name, &args).await {
                            Ok(v) => v,
                            Err(e) => json!({ "error": e }),
                        };
                        let ok = result.get("error").is_none();
                        let _ = tx.unbounded_send(Ok(frame(
                            json!({ "type": "tool", "id": tc.id, "done": true, "ok": ok }),
                        )));
                        display.push(json!({ "type": "tool_result", "name": tc.name, "output": result.clone() }));
                        let content_str = serde_json::to_string(&result).unwrap_or_else(|_| "{}".to_string());
                        messages.push(json!({ "role": "tool", "tool_call_id": tc.id, "content": content_str }));
                    }
                }
                Err(e) => {
                    log::error!("chat: deepseek round failed: {e}");
                    let _ = tx.unbounded_send(Ok(frame(json!({ "type": "error", "error": e }))));
                    errored = true;
                    break;
                }
            }
        }

        if !errored {
            let content = Value::Array(display);
            let msg_id: Option<Uuid> = sqlx::query_scalar(
                "INSERT INTO db_chat_messages \
                   (conversation_id, role, content, model_used, provider_kind, tokens_input, tokens_output, stop_reason) \
                 VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7) RETURNING id",
            )
            .bind(conv_id)
            .bind(&content)
            .bind(&model_label)
            .bind(&provider_kind)
            .bind(tin)
            .bind(tout)
            .bind(&stop)
            .fetch_optional(&pool2)
            .await
            .ok()
            .flatten();
            let _ = sqlx::query("UPDATE db_chat_conversations SET updated_at = NOW() WHERE id = $1")
                .bind(conv_id)
                .execute(&pool2)
                .await;
            let _ = tx.unbounded_send(Ok(frame(json!({
                "type": "done",
                "stop_reason": stop,
                "message_id": msg_id,
                "tokens_input": tin,
                "tokens_output": tout,
            }))));
        }
    });

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(rx)
}

/// Proxy a turn for a `gateway` agent (OpenClaw). Persists user + assistant to
/// db_chat_* (so the agents conversation list/history is uniform) and uses the
/// conversation id as the OpenClaw session key.
async fn gateway_turn(
    pool: DbPool,
    user_id: String,
    conv: ConversationRow,
    msg: String,
    context_ids: Vec<Uuid>,
) -> HttpResponse {
    let (base, token) = match settings::store::openclaw_config(&pool).await {
        Ok(c) => c,
        Err(e) => return HttpResponse::BadRequest().json(ApiError::new(e)),
    };

    let user_content = json!([{ "type": "text", "text": msg }]);
    if let Err(e) =
        sqlx::query("INSERT INTO db_chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)")
            .bind(conv.id)
            .bind(&user_content)
            .execute(&pool)
            .await
    {
        log::error!("gateway chat: persist user msg: {e}");
        return HttpResponse::InternalServerError().json(ApiError::new("database error"));
    }
    if conv.title.as_deref().unwrap_or("").is_empty() {
        let title: String = msg.chars().take(60).collect();
        let _ = sqlx::query("UPDATE db_chat_conversations SET title = $2 WHERE id = $1")
            .bind(conv.id)
            .bind(&title)
            .execute(&pool)
            .await;
    }

    // History → OpenAI messages (no system; the gateway owns its own prompt).
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT role, content FROM db_chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(conv.id)
    .fetch_all(&pool)
    .await
    .unwrap_or_default();
    let mut messages: Vec<Value> = Vec::new();
    for (role, content) in rows {
        if role != "user" && role != "assistant" {
            continue;
        }
        let text = blocks_to_text(&content);
        if text.trim().is_empty() {
            continue;
        }
        messages.push(json!({ "role": role, "content": text }));
    }
    let context = build_context(&pool, &user_id, &context_ids).await;
    inject_context(&mut messages, &context);

    let (tx, rx) = mpsc::unbounded::<Result<Bytes, actix_web::Error>>();
    let pool2 = pool.clone();
    let conv_id = conv.id;
    let session = conv.id.to_string();

    actix_web::rt::spawn(async move {
        match oc_gateway::stream(&base, &token, &session, &messages, &tx).await {
            Ok(out) => {
                let content = json!([{ "type": "text", "text": out.text }]);
                let msg_id: Option<Uuid> = sqlx::query_scalar(
                    "INSERT INTO db_chat_messages (conversation_id, role, content, provider_kind, stop_reason) \
                     VALUES ($1, 'assistant', $2, 'openclaw', $3) RETURNING id",
                )
                .bind(conv_id)
                .bind(&content)
                .bind(&out.stop)
                .fetch_optional(&pool2)
                .await
                .ok()
                .flatten();
                let _ = sqlx::query("UPDATE db_chat_conversations SET updated_at = NOW() WHERE id = $1")
                    .bind(conv_id)
                    .execute(&pool2)
                    .await;
                let _ = tx.unbounded_send(Ok(frame(json!({
                    "type": "done", "stop_reason": out.stop, "message_id": msg_id,
                }))));
            }
            Err(e) => {
                log::error!("gateway chat: {e}");
                let _ = tx.unbounded_send(Ok(frame(json!({ "type": "error", "error": e }))));
            }
        }
    });

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(rx)
}

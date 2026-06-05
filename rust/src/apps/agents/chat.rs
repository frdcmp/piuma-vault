//! Streaming chat turn (SSE). Resolves the conversation's agent/identity/model,
//! assembles the system prompt, persists the user message, streams the DeepSeek
//! response as normalised `data: {type,…}` events, and persists the assistant
//! turn. DeepSeek-only for now; tools come in Phase 5.

use actix_web::{web, HttpResponse, Responder};
use bytes::Bytes;
use futures::channel::mpsc;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::identities;
use super::models::{ApiError, ChatTurnReq, ConversationRow, ModelRow, ProviderRow};
use super::providers::deepseek;

/// Concatenate the text-type blocks of a stored message into a plain string.
fn blocks_to_text(content: &Json) -> String {
    match content {
        Json::String(s) => s.clone(),
        Json::Array(blocks) => {
            let mut out = String::new();
            for b in blocks {
                if b.get("type").and_then(|t| t.as_str()) == Some("text") {
                    if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                        out.push_str(t);
                    }
                }
            }
            out
        }
        _ => String::new(),
    }
}

fn done_event(payload: Json) -> Bytes {
    Bytes::from(format!("data: {payload}\n\n"))
}

pub async fn chat(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<ChatTurnReq>,
) -> impl Responder {
    let conv_id = path.into_inner();
    let msg = body.into_inner().message;
    let db = pool.get_ref();

    // ── Conversation ──
    let conv = match sqlx::query_as::<_, ConversationRow>(
        "SELECT * FROM db_chat_conversations WHERE id = $1",
    )
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

    // ── Model (pinned, else global default) ──
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
        return HttpResponse::BadRequest()
            .json(ApiError::new("no model configured — add one in admin → Agents"));
    };

    // ── Provider (DeepSeek only for now) ──
    let provider: ProviderRow =
        match sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
            .bind(model_row.provider_id)
            .fetch_optional(db)
            .await
        {
            Ok(Some(p)) => p,
            _ => return HttpResponse::BadRequest().json(ApiError::new("provider not found")),
        };
    if provider.kind != "deepseek" {
        return HttpResponse::BadRequest()
            .json(ApiError::new("only the deepseek provider is supported for now"));
    }
    if provider.api_key.trim().is_empty() {
        return HttpResponse::BadRequest().json(ApiError::new("provider has no API key set"));
    }

    // ── System prompt (agent profile + persona) ──
    let resolved = match identities::resolve(db, &conv.agent, &conv.identity).await {
        Ok(r) => r,
        Err(e) => return HttpResponse::BadRequest().json(ApiError::new(e)),
    };

    // ── Persist the user message; set a title on first turn ──
    let user_content = json!([{ "type": "text", "text": msg }]);
    if let Err(e) = sqlx::query(
        "INSERT INTO db_chat_messages (conversation_id, role, content) VALUES ($1, 'user', $2)",
    )
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

    // ── History → (role, text), capped to the most recent turns ──
    let rows: Vec<(String, Json)> = sqlx::query_as(
        "SELECT role, content FROM db_chat_messages WHERE conversation_id = $1 ORDER BY created_at",
    )
    .bind(conv_id)
    .fetch_all(db)
    .await
    .unwrap_or_default();
    let mut messages: Vec<(String, String)> = rows
        .into_iter()
        .filter(|(role, _)| role == "user" || role == "assistant")
        .map(|(role, content)| (role, blocks_to_text(&content)))
        .filter(|(_, text)| !text.trim().is_empty())
        .collect();
    const MAX_TURNS: usize = 50; // hard truncation (plan §14.5)
    if messages.len() > MAX_TURNS {
        messages.drain(..messages.len() - MAX_TURNS);
    }

    // ── Stream ──
    let (tx, rx) = mpsc::unbounded::<Result<Bytes, actix_web::Error>>();
    let pool2 = db.clone();
    let model_label = model_row.model_id.clone();
    let provider_kind = provider.kind.clone();
    let input = deepseek::TurnInput {
        api_key: provider.api_key.clone(),
        base_url: provider.base_url.clone(),
        model: model_row.model_id.clone(),
        system: resolved.system_prompt.clone(),
        messages,
    };

    actix_web::rt::spawn(async move {
        match deepseek::run(input, &tx).await {
            Ok(out) => {
                let mut blocks: Vec<Json> = Vec::new();
                if !out.thinking.trim().is_empty() {
                    blocks.push(json!({ "type": "thinking", "text": out.thinking }));
                }
                blocks.push(json!({ "type": "text", "text": out.text }));
                let content = Json::Array(blocks);
                let msg_id: Option<Uuid> = sqlx::query_scalar(
                    "INSERT INTO db_chat_messages \
                       (conversation_id, role, content, model_used, provider_kind, \
                        tokens_input, tokens_output, stop_reason) \
                     VALUES ($1, 'assistant', $2, $3, $4, $5, $6, $7) RETURNING id",
                )
                .bind(conv_id)
                .bind(&content)
                .bind(&model_label)
                .bind(&provider_kind)
                .bind(out.tokens_input)
                .bind(out.tokens_output)
                .bind(&out.stop_reason)
                .fetch_optional(&pool2)
                .await
                .ok()
                .flatten();
                let _ = sqlx::query("UPDATE db_chat_conversations SET updated_at = NOW() WHERE id = $1")
                    .bind(conv_id)
                    .execute(&pool2)
                    .await;
                let _ = tx.unbounded_send(Ok(done_event(json!({
                    "type": "done",
                    "stop_reason": out.stop_reason,
                    "message_id": msg_id,
                    "tokens_input": out.tokens_input,
                    "tokens_output": out.tokens_output,
                }))));
            }
            Err(e) => {
                log::error!("chat: deepseek turn failed: {e}");
                let _ = tx.unbounded_send(Ok(done_event(json!({ "type": "error", "error": e }))));
            }
        }
        // tx dropped here → response stream ends.
    });

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(rx)
}

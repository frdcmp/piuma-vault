use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use log::{error, info};
use serde::Deserialize;

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use crate::apps::auth::models::Claims;

/// Validate a JWT Bearer access token (mirrors `auth::middleware::Auth::validate_token`).
fn validate_bearer(req: &HttpRequest) -> Result<Claims, String> {
    const PUBLIC_KEY: &[u8] = include_bytes!("../../keys/jwt-public.pem");

    let header = req
        .headers()
        .get("Authorization")
        .ok_or_else(|| "Authentication required".to_string())?;
    let s = header
        .to_str()
        .map_err(|_| "Invalid Authorization header".to_string())?;
    let token = s
        .strip_prefix("Bearer ")
        .or_else(|| s.strip_prefix("bearer "))
        .ok_or_else(|| "Invalid Authorization header".to_string())?;

    let key = DecodingKey::from_rsa_pem(PUBLIC_KEY)
        .map_err(|_| "Internal authentication error".to_string())?;
    let mut validation = Validation::new(Algorithm::RS256);
    validation.leeway = 60;

    let data = decode::<Claims>(token, &key, &validation)
        .map_err(|_| "Invalid authentication token".to_string())?;

    if data.claims.token_type != "access" {
        return Err("Invalid token type".to_string());
    }

    Ok(data.claims)
}

const DEFAULT_MODEL: &str = "openclaw";

#[derive(Debug, Deserialize)]
pub struct OpenClawChatRequest {
    /// OpenAI-shaped message list: [{role, content}, ...]
    pub messages: Vec<serde_json::Value>,
    #[serde(default)]
    pub model: Option<String>,
}

pub async fn openclaw_chat(
    req: HttpRequest,
    body: web::Json<OpenClawChatRequest>,
    pool: web::Data<crate::db::db::DbPool>,
) -> HttpResponse {
    if let Err(msg) = validate_bearer(&req) {
        return HttpResponse::Unauthorized().body(msg);
    }

    // URL + gateway token come from the Services dashboard (app_settings).
    let (base, token) = match crate::apps::settings::store::openclaw_config(pool.get_ref()).await {
        Ok(cfg) => cfg,
        Err(e) => {
            error!("OpenClaw not configured: {e}");
            return HttpResponse::InternalServerError().body(e);
        }
    };

    let upstream = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
    let model = body
        .model
        .clone()
        .unwrap_or_else(|| DEFAULT_MODEL.to_string());

    let payload = serde_json::json!({
        "model": model,
        "messages": body.messages,
        "stream": true,
    });

    info!(
        "[openclaw] streaming POST → {} (model={}, {} msgs)",
        upstream,
        model,
        body.messages.len()
    );

    let client = reqwest::Client::new();
    let mut upstream_req = client.post(&upstream).bearer_auth(&token).json(&payload);
    if let Some(session_key) = req.headers().get("x-openclaw-session-key") {
        upstream_req = upstream_req.header("x-openclaw-session-key", session_key);
    }
    let resp = match upstream_req.send().await {
        Ok(r) => r,
        Err(e) => {
            error!("[openclaw] upstream error: {}", e);
            return HttpResponse::BadGateway().body(format!("upstream: {}", e));
        }
    };

    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        error!("[openclaw] upstream returned {}: {}", status, text);
        return HttpResponse::build(status).body(text);
    }

    let stream = resp
        .bytes_stream()
        .map(|chunk| chunk.map_err(actix_web::error::ErrorInternalServerError));

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(stream)
}

#[derive(Debug, Deserialize)]
pub struct HistoryQuery {
    /// Max messages to return; forwarded to the gateway. Defaults to 200.
    #[serde(default)]
    pub limit: Option<u32>,
}

/// Flatten a gateway transcript `content` value into plain display text.
/// The gateway stores content as a block array (`[{type:"text",text:"…"}]`);
/// we keep only the `text` blocks and join them. A bare string is passed through.
fn flatten_content(content: &serde_json::Value) -> String {
    match content {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Array(blocks) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
            .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Undo the XML-attribute escaping the clients apply to note paths.
fn unescape_xml_attr(s: &str) -> String {
    s.replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&amp;", "&")
}

/// Clients wrap a turn's attached notes in a leading `<context>…</context>`
/// block (see the web/mobile composers). The gateway stores that verbatim, so
/// on load we split it back out: the note paths become a `context` array and
/// the visible text is the remainder. Messages without the block pass through.
fn split_context(content: &str) -> (String, Vec<String>) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("<context>") {
        return (content.to_string(), Vec::new());
    }
    let Some(end) = trimmed.find("</context>") else {
        return (content.to_string(), Vec::new());
    };
    let block = &trimmed[..end];
    let rest = &trimmed[end + "</context>".len()..];

    let mut paths = Vec::new();
    let mut hay = block;
    while let Some(i) = hay.find("path=\"") {
        let start = i + "path=\"".len();
        let Some(j) = hay[start..].find('"') else { break };
        paths.push(unescape_xml_attr(&hay[start..start + j]));
        hay = &hay[start + j + 1..];
    }

    let cleaned = rest
        .trim_start_matches(['\n', '\r', ' ', '\t'])
        .to_string();
    (cleaned, paths)
}

/// Load the conversation transcript for a session FROM the OpenClaw gateway.
/// Conversations are not persisted on our side — the gateway is the single
/// source of truth, keyed by the client's `x-openclaw-session-key`. Returns
/// `{ messages: [{role, content}], hasMore }` with display-normalized text.
/// A not-yet-existing session (gateway 404) yields an empty transcript.
pub async fn openclaw_history(
    req: HttpRequest,
    query: web::Query<HistoryQuery>,
    pool: web::Data<crate::db::db::DbPool>,
) -> HttpResponse {
    if let Err(msg) = validate_bearer(&req) {
        return HttpResponse::Unauthorized().body(msg);
    }

    let session_key = match req.headers().get("x-openclaw-session-key") {
        Some(v) => match v.to_str() {
            Ok(s) if !s.trim().is_empty() => s.trim().to_string(),
            _ => return HttpResponse::BadRequest().body("invalid x-openclaw-session-key"),
        },
        None => return HttpResponse::BadRequest().body("missing x-openclaw-session-key"),
    };

    let (base, token) = match crate::apps::settings::store::openclaw_config(pool.get_ref()).await {
        Ok(cfg) => cfg,
        Err(e) => {
            error!("OpenClaw not configured: {e}");
            return HttpResponse::InternalServerError().body(e);
        }
    };

    let limit = query.limit.unwrap_or(200);
    // Shared-secret Bearer auth over HTTP is treated as full operator access by
    // the gateway, so this read needs no device pairing / scope negotiation.
    // The gateway resolves our raw session key to its canonical store key.
    let upstream = format!(
        "{}/sessions/{}/history?limit={}",
        base.trim_end_matches('/'),
        urlencoding::encode(&session_key),
        limit
    );

    let client = reqwest::Client::new();
    let resp = match client.get(&upstream).bearer_auth(&token).send().await {
        Ok(r) => r,
        Err(e) => {
            error!("[openclaw] history upstream error: {}", e);
            return HttpResponse::BadGateway().body(format!("upstream: {}", e));
        }
    };

    let status = resp.status();
    // No session yet (nothing sent on this key) → empty transcript, not an error.
    if status == reqwest::StatusCode::NOT_FOUND {
        return HttpResponse::Ok().json(serde_json::json!({ "messages": [], "hasMore": false }));
    }
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        error!("[openclaw] history returned {}: {}", status, text);
        return HttpResponse::build(status).body(text);
    }

    let body: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(e) => {
            error!("[openclaw] history parse error: {}", e);
            return HttpResponse::BadGateway().body("invalid upstream response");
        }
    };

    // Map the gateway transcript to our minimal UI shape. Only user/assistant
    // turns with visible text survive; tool-only entries and other roles drop.
    let messages: Vec<serde_json::Value> = body
        .get("messages")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| {
                    let role = m.get("role").and_then(|r| r.as_str())?;
                    if role != "user" && role != "assistant" {
                        return None;
                    }
                    let raw = flatten_content(m.get("content").unwrap_or(&serde_json::Value::Null));
                    // Recover the attached-note chips and clean the visible text.
                    let (content, context) = split_context(&raw);
                    if content.trim().is_empty() && context.is_empty() {
                        return None;
                    }
                    let mut obj = serde_json::json!({ "role": role, "content": content });
                    if !context.is_empty() {
                        obj["context"] = serde_json::json!(context);
                    }
                    Some(obj)
                })
                .collect()
        })
        .unwrap_or_default();

    let has_more = body
        .get("hasMore")
        .and_then(|h| h.as_bool())
        .unwrap_or(false);

    HttpResponse::Ok().json(serde_json::json!({ "messages": messages, "hasMore": has_more }))
}

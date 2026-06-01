use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::StreamExt;
use log::{error, info};
use serde::Deserialize;

use jsonwebtoken::{decode, Algorithm, DecodingKey, Validation};
use crate::apps::auth::models::Claims;

/// Validate a JWT Bearer access token (mirrors `auth::middleware::Auth::validate_token`).
fn validate_bearer(req: &HttpRequest) -> Result<Claims, String> {
    const PUBLIC_KEY: &[u8] = include_bytes!("../../../keys/jwt-public.pem");

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

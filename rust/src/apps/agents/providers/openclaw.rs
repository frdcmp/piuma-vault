//! Gateway proxy to the OpenClaw chat service. Streams the gateway's
//! OpenAI-format SSE and surfaces content deltas as our `{type:"text"}` events.
//! The OpenClaw session is keyed by the agents conversation id, so each thread
//! maps to its own gateway session.

use bytes::Bytes;
use futures::channel::mpsc::UnboundedSender;
use futures::StreamExt;
use serde_json::{json, Value};

pub type SseSender = UnboundedSender<Result<Bytes, actix_web::Error>>;

#[derive(Default)]
pub struct GatewayResult {
    pub text: String,
    pub stop: String,
}

pub async fn stream(
    base: &str,
    token: &str,
    session_key: &str,
    messages: &[Value],
    tx: &SseSender,
) -> Result<GatewayResult, String> {
    let url = format!("{}/v1/chat/completions", base.trim_end_matches('/'));
    let payload = json!({ "model": "openclaw", "messages": messages, "stream": true });

    let client = reqwest::Client::new();
    let mut req = client
        .post(&url)
        .json(&payload)
        .header("x-openclaw-session-key", session_key);
    if !token.is_empty() {
        req = req.bearer_auth(token);
    }
    let resp = req
        .send()
        .await
        .map_err(|e| format!("openclaw request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("openclaw HTTP {status}: {body}"));
    }

    let mut out = GatewayResult {
        text: String::new(),
        stop: "end_turn".to_string(),
    };
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("openclaw stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));
        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            if !line.starts_with("data:") {
                continue;
            }
            let data = line["data:".len()..].trim();
            if data.is_empty() || data == "[DONE]" {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            if let Some(choice) = v.get("choices").and_then(|c| c.get(0)) {
                if let Some(t) = choice
                    .get("delta")
                    .and_then(|d| d.get("content"))
                    .and_then(|x| x.as_str())
                {
                    if !t.is_empty() {
                        out.text.push_str(t);
                        let _ = tx.unbounded_send(Ok(Bytes::from(format!(
                            "data: {}\n\n",
                            json!({ "type": "text", "delta": t })
                        ))));
                    }
                }
                if choice.get("finish_reason").and_then(|x| x.as_str()) == Some("length") {
                    out.stop = "max_tokens".to_string();
                }
            }
        }
    }
    Ok(out)
}

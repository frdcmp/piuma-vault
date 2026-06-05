//! DeepSeek streaming chat adapter (OpenAI-compatible `/chat/completions`).
//! Streams the upstream SSE, emits our normalised `data: {type,…}` events to the
//! client via `tx`, and returns the accumulated turn for persistence.
//!
//! Thinking: DeepSeek returns reasoning on `delta.reasoning_content` — surfaced
//! as `type:"thinking"` events. Tools are not wired yet (DeepSeek-only first cut).

use bytes::Bytes;
use futures::channel::mpsc::UnboundedSender;
use futures::StreamExt;
use serde_json::json;

pub const DEFAULT_BASE_URL: &str = "https://api.deepseek.com";

pub type SseSender = UnboundedSender<Result<Bytes, actix_web::Error>>;

pub struct TurnInput {
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: String,
    pub system: String,
    /// (role, text) — role is "user" | "assistant".
    pub messages: Vec<(String, String)>,
}

#[derive(Default)]
pub struct TurnOutput {
    pub text: String,
    pub thinking: String,
    pub stop_reason: String,
    pub tokens_input: i32,
    pub tokens_output: i32,
}

fn sse(tx: &SseSender, payload: serde_json::Value) {
    let _ = tx.unbounded_send(Ok(Bytes::from(format!("data: {payload}\n\n"))));
}

fn map_finish(reason: &str) -> &'static str {
    match reason {
        "stop" => "end_turn",
        "length" => "max_tokens",
        "tool_calls" => "tool_use",
        "content_filter" => "refusal",
        _ => "end_turn",
    }
}

pub async fn run(input: TurnInput, tx: &SseSender) -> Result<TurnOutput, String> {
    let base = input
        .base_url
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(DEFAULT_BASE_URL)
        .trim_end_matches('/')
        .to_string();
    let url = format!("{base}/chat/completions");

    // Build messages: system first, then history.
    let mut msgs: Vec<serde_json::Value> = Vec::with_capacity(input.messages.len() + 1);
    if !input.system.trim().is_empty() {
        msgs.push(json!({ "role": "system", "content": input.system }));
    }
    for (role, text) in &input.messages {
        msgs.push(json!({ "role": role, "content": text }));
    }

    let payload = json!({
        "model": input.model,
        "messages": msgs,
        "stream": true,
        "stream_options": { "include_usage": true },
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(&input.api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("deepseek request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("deepseek HTTP {status}: {body}"));
    }

    let mut out = TurnOutput::default();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("deepseek stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        // Process complete lines; keep any partial trailing line in `buf`.
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
            let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
                continue;
            };

            if let Some(choice) = v.get("choices").and_then(|c| c.get(0)) {
                if let Some(delta) = choice.get("delta") {
                    if let Some(t) = delta.get("reasoning_content").and_then(|x| x.as_str()) {
                        if !t.is_empty() {
                            out.thinking.push_str(t);
                            sse(tx, json!({ "type": "thinking", "delta": t }));
                        }
                    }
                    if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
                        if !t.is_empty() {
                            out.text.push_str(t);
                            sse(tx, json!({ "type": "text", "delta": t }));
                        }
                    }
                }
                if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) {
                    out.stop_reason = map_finish(fr).to_string();
                }
            }

            if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
                out.tokens_input = usage
                    .get("prompt_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0) as i32;
                out.tokens_output = usage
                    .get("completion_tokens")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0) as i32;
            }
        }
    }

    if out.stop_reason.is_empty() {
        out.stop_reason = "end_turn".to_string();
    }
    Ok(out)
}

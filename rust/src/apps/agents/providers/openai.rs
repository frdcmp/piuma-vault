//! OpenAI streaming chat adapter — the canonical `/chat/completions` wire
//! format. One `call` = one model round: streams text to the client and
//! accumulates any `tool_calls` for the agent loop (chat.rs) to run and call
//! again. (OpenAI doesn't expose reasoning tokens over the API, so there's no
//! thinking channel here.)

use futures::StreamExt;
use serde_json::{json, Value};

use super::{CallResult, SseSender, ToolCall};

pub const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

fn base(b: Option<&str>) -> &str {
    b.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_BASE_URL)
}

fn sse(tx: &SseSender, payload: Value) {
    let _ = tx.unbounded_send(Ok(bytes::Bytes::from(format!("data: {payload}\n\n"))));
}

fn map_finish(reason: &str) -> &'static str {
    match reason {
        "stop" => "end_turn",
        "length" => "max_tokens",
        "tool_calls" | "function_call" => "tool_use",
        "content_filter" => "refusal",
        _ => "end_turn",
    }
}

/// One non-streaming completion. Returns the assistant's text only. Used for
/// short utility calls (e.g. generating conversation titles) where SSE and the
/// tool loop aren't needed.
pub async fn complete(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Result<String, String> {
    complete_usage(api_key, base_url, model, messages, max_tokens)
        .await
        .map(|(t, _, _)| t)
}

/// Like `complete`, but also returns `(tokens_in, tokens_out)` from `usage`.
pub async fn complete_usage(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Result<(String, i32, i32), String> {
    let url = format!("{}/chat/completions", base(base_url).trim_end_matches('/'));

    let payload = json!({
        "model": model,
        "messages": messages,
        "stream": false,
        "max_tokens": max_tokens,
    });

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("openai HTTP {status}: {body}"));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("openai decode failed: {e}"))?;
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("")
        .to_string();
    let (tin, tout) = super::deepseek::openai_usage(&v);
    Ok((text, tin, tout))
}

/// One streaming model round. `messages`/`tools` are raw OpenAI-shaped JSON.
pub async fn call(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    tx: &SseSender,
) -> Result<CallResult, String> {
    let url = format!("{}/chat/completions", base(base_url).trim_end_matches('/'));

    let mut payload = json!({
        "model": model,
        "messages": messages,
        "stream": true,
        "stream_options": { "include_usage": true },
    });
    if !tools.is_empty() {
        payload["tools"] = json!(tools);
        payload["tool_choice"] = json!("auto");
    }

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("openai HTTP {status}: {body}"));
    }

    let mut out = CallResult::default();
    // tool_calls stream incrementally, keyed by `index`.
    let mut tc_acc: Vec<ToolCall> = Vec::new();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("openai stream error: {e}"))?;
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
                if let Some(delta) = choice.get("delta") {
                    if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
                        if !t.is_empty() {
                            out.text.push_str(t);
                            sse(tx, json!({ "type": "text", "delta": t }));
                        }
                    }
                    if let Some(calls) = delta.get("tool_calls").and_then(|x| x.as_array()) {
                        for c in calls {
                            let idx = c.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                            while tc_acc.len() <= idx {
                                tc_acc.push(ToolCall {
                                    id: String::new(),
                                    name: String::new(),
                                    arguments: String::new(),
                                });
                            }
                            let slot = &mut tc_acc[idx];
                            if let Some(id) = c.get("id").and_then(|x| x.as_str()) {
                                if !id.is_empty() {
                                    slot.id = id.to_string();
                                }
                            }
                            if let Some(f) = c.get("function") {
                                if let Some(n) = f.get("name").and_then(|x| x.as_str()) {
                                    if !n.is_empty() {
                                        slot.name = n.to_string();
                                    }
                                }
                                if let Some(a) = f.get("arguments").and_then(|x| x.as_str()) {
                                    slot.arguments.push_str(a);
                                }
                            }
                        }
                    }
                }
                if let Some(fr) = choice.get("finish_reason").and_then(|x| x.as_str()) {
                    out.finish = map_finish(fr).to_string();
                }
            }

            if let Some(usage) = v.get("usage").filter(|u| !u.is_null()) {
                let prompt = usage.get("prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                let cached = usage
                    .get("prompt_tokens_details")
                    .and_then(|d| d.get("cached_tokens"))
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0) as i32;
                out.tokens_cached = cached;
                out.tokens_in = (prompt - cached).max(0);
                out.tokens_out = usage.get("completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            }
        }
    }

    out.tool_calls = tc_acc.into_iter().filter(|t| !t.name.is_empty()).collect();
    if out.finish.is_empty() {
        out.finish = if out.tool_calls.is_empty() { "end_turn".into() } else { "tool_use".into() };
    }
    Ok(out)
}

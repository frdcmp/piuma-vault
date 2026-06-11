//! Minimax streaming chat adapter (OpenAI-compatible `/chat/completions`). The
//! M-series reasoning models inline their chain of thought as a leading
//! `<think>…</think>` block in the message *content* (rather than a separate
//! `reasoning_content` field), so this adapter peels that block out into the
//! thinking channel — tag-safe across streaming chunk boundaries — leaving the
//! answer text clean.

use futures::StreamExt;
use serde_json::{json, Value};

use super::{CallResult, SseSender, ToolCall};

pub const DEFAULT_BASE_URL: &str = "https://api.minimax.io/v1";

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
        "tool_calls" => "tool_use",
        "content_filter" => "refusal",
        _ => "end_turn",
    }
}

fn emit_text(out: &mut CallResult, tx: &SseSender, s: &str) {
    if s.is_empty() {
        return;
    }
    out.text.push_str(s);
    sse(tx, json!({ "type": "text", "delta": s }));
}

fn emit_think(out: &mut CallResult, tx: &SseSender, s: &str) {
    if s.is_empty() {
        return;
    }
    out.thinking.push_str(s);
    sse(tx, json!({ "type": "thinking", "delta": s }));
}

const THINK_OPEN: &str = "<think>";
const THINK_CLOSE: &str = "</think>";

/// Bytes at the end of `buf` that are a prefix of `tag` — held back in case the
/// tag is still streaming in. Only counts a cut that lands on a char boundary.
fn held_back(buf: &str, tag: &str) -> usize {
    let b = buf.as_bytes();
    let t = tag.as_bytes();
    let max = t.len().min(b.len());
    for n in (1..=max).rev() {
        if b[b.len() - n..] == t[..n] && buf.is_char_boundary(buf.len() - n) {
            return n;
        }
    }
    0
}

#[derive(PartialEq)]
enum ThinkPhase {
    Start,
    InThink,
    Body,
}

/// Streaming splitter that peels a leading `<think>…</think>` block out of the
/// content stream so it surfaces as thinking, not answer text.
struct ThinkSplitter {
    phase: ThinkPhase,
    pending: String,
}

impl ThinkSplitter {
    fn new() -> Self {
        Self {
            phase: ThinkPhase::Start,
            pending: String::new(),
        }
    }

    fn feed(&mut self, delta: &str, out: &mut CallResult, tx: &SseSender) {
        self.pending.push_str(delta);
        loop {
            match self.phase {
                ThinkPhase::Start => {
                    let trimmed = self.pending.trim_start();
                    if trimmed.is_empty() {
                        return; // only whitespace so far — wait
                    }
                    // Might still be opening with "<think>": wait for more.
                    if trimmed.len() < THINK_OPEN.len() && THINK_OPEN.starts_with(trimmed) {
                        return;
                    }
                    if let Some(rest) = trimmed.strip_prefix(THINK_OPEN) {
                        self.pending = rest.to_string();
                        self.phase = ThinkPhase::InThink;
                        continue;
                    }
                    // No think block — the whole stream is answer text.
                    let chunk = std::mem::take(&mut self.pending);
                    emit_text(out, tx, &chunk);
                    self.phase = ThinkPhase::Body;
                    return;
                }
                ThinkPhase::InThink => {
                    if let Some(idx) = self.pending.find(THINK_CLOSE) {
                        let think = self.pending[..idx].to_string();
                        self.pending = self.pending[idx + THINK_CLOSE.len()..].to_string();
                        emit_think(out, tx, &think);
                        self.phase = ThinkPhase::Body;
                        continue;
                    }
                    let safe = self.pending.len() - held_back(&self.pending, THINK_CLOSE);
                    if safe > 0 {
                        let part: String = self.pending.drain(..safe).collect();
                        emit_think(out, tx, &part);
                    }
                    return;
                }
                ThinkPhase::Body => {
                    let chunk = std::mem::take(&mut self.pending);
                    emit_text(out, tx, &chunk);
                    return;
                }
            }
        }
    }

    fn finish(&mut self, out: &mut CallResult, tx: &SseSender) {
        let chunk = std::mem::take(&mut self.pending);
        if self.phase == ThinkPhase::InThink {
            emit_think(out, tx, &chunk);
        } else {
            emit_text(out, tx, &chunk);
        }
    }
}

/// Drop a leading `<think>…</think>` block from a non-streamed completion.
fn strip_think(s: &str) -> String {
    let t = s.trim_start();
    if let Some(rest) = t.strip_prefix(THINK_OPEN) {
        if let Some(end) = rest.find(THINK_CLOSE) {
            return rest[end + THINK_CLOSE.len()..].trim_start().to_string();
        }
    }
    s.to_string()
}

/// One non-streaming completion. Returns the assistant's text, with any leading
/// `<think>` block stripped. Used for short utility calls (titles, etc.).
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
        .map_err(|e| format!("minimax request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("minimax HTTP {status}: {body}"));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("minimax decode failed: {e}"))?;
    let text = v
        .get("choices")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("message"))
        .and_then(|m| m.get("content"))
        .and_then(|t| t.as_str())
        .unwrap_or("");
    let (tin, tout) = super::deepseek::openai_usage(&v);
    Ok((strip_think(text), tin, tout))
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
        .map_err(|e| format!("minimax request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("minimax HTTP {status}: {body}"));
    }

    let mut out = CallResult::default();
    let mut splitter = ThinkSplitter::new();
    // tool_calls stream incrementally, keyed by `index`.
    let mut tc_acc: Vec<ToolCall> = Vec::new();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("minimax stream error: {e}"))?;
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
                    if let Some(t) = delta.get("reasoning_content").and_then(|x| x.as_str()) {
                        emit_think(&mut out, tx, t);
                    }
                    if let Some(t) = delta.get("content").and_then(|x| x.as_str()) {
                        if !t.is_empty() {
                            splitter.feed(t, &mut out, tx);
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

    splitter.finish(&mut out, tx);
    out.tool_calls = tc_acc.into_iter().filter(|t| !t.name.is_empty()).collect();
    if out.finish.is_empty() {
        out.finish = if out.tool_calls.is_empty() { "end_turn".into() } else { "tool_use".into() };
    }
    Ok(out)
}

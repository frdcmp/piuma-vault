//! Anthropic Messages API adapter. The chat loop speaks OpenAI-shaped JSON
//! (system/user/assistant/tool messages, `tool_calls`, `function`-style tools),
//! so this module translates in both directions: OpenAI → Anthropic on the way
//! out, Anthropic's streaming events → our shared `CallResult` on the way back.
//! Emits the same `{type: thinking|text|tool}` SSE frames as the DeepSeek path.

use futures::StreamExt;
use serde_json::{json, Value};

use super::{CallResult, SseSender, ToolCall};

pub const DEFAULT_BASE_URL: &str = "https://api.anthropic.com";
const API_VERSION: &str = "2023-06-01";

fn base(b: Option<&str>) -> &str {
    b.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_BASE_URL)
}
// Anthropic requires `max_tokens`; the OpenAI path leaves it implicit. Generous
// so reasoning/long answers aren't truncated mid-turn.
const DEFAULT_MAX_TOKENS: u32 = 8192;

fn sse(tx: &SseSender, payload: Value) {
    let _ = tx.unbounded_send(Ok(bytes::Bytes::from(format!("data: {payload}\n\n"))));
}

fn map_finish(reason: &str) -> &'static str {
    match reason {
        "end_turn" | "stop_sequence" => "end_turn",
        "max_tokens" => "max_tokens",
        "tool_use" => "tool_use",
        "refusal" => "refusal",
        _ => "end_turn",
    }
}

/// Append blocks to the last message if it shares `role` (Anthropic requires
/// alternating roles, so consecutive tool results must coalesce), else push a
/// fresh message.
fn push_msg(out: &mut Vec<Value>, role: &str, mut blocks: Vec<Value>) {
    if let Some(last) = out.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some(role) {
            if let Some(arr) = last.get_mut("content").and_then(|c| c.as_array_mut()) {
                arr.append(&mut blocks);
                return;
            }
        }
    }
    if blocks.is_empty() {
        // Anthropic rejects empty content; keep the turn well-formed.
        blocks.push(json!({ "type": "text", "text": " " }));
    }
    out.push(json!({ "role": role, "content": blocks }));
}

/// OpenAI-shaped messages → (system prompt, Anthropic `messages`).
fn translate_messages(messages: &[Value]) -> (String, Vec<Value>) {
    let mut system = String::new();
    let mut out: Vec<Value> = Vec::new();
    for m in messages {
        let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("user");
        match role {
            "system" => {
                if let Some(c) = m.get("content").and_then(|c| c.as_str()) {
                    if !system.is_empty() {
                        system.push_str("\n\n");
                    }
                    system.push_str(c);
                }
            }
            // OpenAI tool result → Anthropic tool_result block on a user message.
            "tool" => {
                let id = m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("");
                let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                push_msg(
                    &mut out,
                    "user",
                    vec![json!({ "type": "tool_result", "tool_use_id": id, "content": content })],
                );
            }
            "assistant" => {
                let mut blocks: Vec<Value> = Vec::new();
                if let Some(t) = m.get("content").and_then(|c| c.as_str()) {
                    if !t.is_empty() {
                        blocks.push(json!({ "type": "text", "text": t }));
                    }
                }
                if let Some(tcs) = m.get("tool_calls").and_then(|v| v.as_array()) {
                    for tc in tcs {
                        let f = tc.get("function");
                        let id = tc.get("id").and_then(|v| v.as_str()).unwrap_or("");
                        let name = f
                            .and_then(|f| f.get("name"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("");
                        let args = f
                            .and_then(|f| f.get("arguments"))
                            .and_then(|v| v.as_str())
                            .unwrap_or("{}");
                        let input: Value = serde_json::from_str(args).unwrap_or_else(|_| json!({}));
                        blocks.push(json!({ "type": "tool_use", "id": id, "name": name, "input": input }));
                    }
                }
                push_msg(&mut out, "assistant", blocks);
            }
            // user (and anything else) → plain text block.
            _ => {
                let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                push_msg(&mut out, "user", vec![json!({ "type": "text", "text": content })]);
            }
        }
    }
    (system, out)
}

/// OpenAI `function` tool schemas → Anthropic tool schemas.
fn translate_tools(tools: &[Value]) -> Vec<Value> {
    tools
        .iter()
        .filter_map(|t| t.get("function"))
        .map(|f| {
            json!({
                "name": f.get("name").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or_else(|| json!("")),
                "input_schema": f.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object" })),
            })
        })
        .collect()
}

fn build_body(
    model: &str,
    system: &str,
    messages: Vec<Value>,
    tools: &[Value],
    max_tokens: u32,
    stream: bool,
) -> Value {
    let mut body = json!({
        "model": model,
        "max_tokens": max_tokens,
        "messages": messages,
        "stream": stream,
    });
    if !system.trim().is_empty() {
        body["system"] = json!(system);
    }
    if !tools.is_empty() {
        body["tools"] = json!(translate_tools(tools));
    }
    body
}

/// One non-streaming completion. Returns the assistant's text.
pub async fn complete(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Result<String, String> {
    let base = base(base_url).trim_end_matches('/');
    let url = format!("{base}/v1/messages");
    let (system, msgs) = translate_messages(messages);
    let body = build_body(model, &system, msgs, &[], max_tokens, false);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic HTTP {status}: {body}"));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("anthropic decode failed: {e}"))?;
    let text = v
        .get("content")
        .and_then(|c| c.as_array())
        .map(|blocks| {
            blocks
                .iter()
                .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default();
    Ok(text)
}

struct ToolAcc {
    id: String,
    name: String,
    args: String,
}

/// One streaming model round. Parses Anthropic SSE events into `CallResult`,
/// forwarding text/thinking/tool deltas as our own SSE frames.
pub async fn call(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    tx: &SseSender,
) -> Result<CallResult, String> {
    let base = base(base_url).trim_end_matches('/');
    let url = format!("{base}/v1/messages");
    let (system, msgs) = translate_messages(messages);
    let body = build_body(model, &system, msgs, tools, DEFAULT_MAX_TOKENS, true);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .header("x-api-key", api_key)
        .header("anthropic-version", API_VERSION)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("anthropic request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("anthropic HTTP {status}: {body}"));
    }

    let mut out = CallResult::default();
    // Content blocks arrive keyed by `index`; tool_use blocks stream their input
    // as `partial_json` we accumulate until the block stops.
    let mut blocks: Vec<Option<ToolAcc>> = Vec::new();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("anthropic stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
            // Each `data:` line is self-describing via its `type`; ignore the
            // paired `event:` lines.
            if !line.starts_with("data:") {
                continue;
            }
            let data = line["data:".len()..].trim();
            if data.is_empty() {
                continue;
            }
            let Ok(v) = serde_json::from_str::<Value>(data) else {
                continue;
            };
            match v.get("type").and_then(|t| t.as_str()) {
                Some("message_start") => {
                    if let Some(u) = v.get("message").and_then(|m| m.get("usage")) {
                        out.tokens_in =
                            u.get("input_tokens").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                    }
                }
                Some("content_block_start") => {
                    let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    while blocks.len() <= idx {
                        blocks.push(None);
                    }
                    let cb = v.get("content_block");
                    if cb.and_then(|c| c.get("type")).and_then(|t| t.as_str()) == Some("tool_use") {
                        let cb = cb.unwrap();
                        blocks[idx] = Some(ToolAcc {
                            id: cb.get("id").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            name: cb.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                            args: String::new(),
                        });
                    }
                }
                Some("content_block_delta") => {
                    let idx = v.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                    if let Some(delta) = v.get("delta") {
                        match delta.get("type").and_then(|t| t.as_str()) {
                            Some("text_delta") => {
                                if let Some(t) = delta.get("text").and_then(|x| x.as_str()) {
                                    if !t.is_empty() {
                                        out.text.push_str(t);
                                        sse(tx, json!({ "type": "text", "delta": t }));
                                    }
                                }
                            }
                            Some("thinking_delta") => {
                                if let Some(t) = delta.get("thinking").and_then(|x| x.as_str()) {
                                    if !t.is_empty() {
                                        out.thinking.push_str(t);
                                        sse(tx, json!({ "type": "thinking", "delta": t }));
                                    }
                                }
                            }
                            Some("input_json_delta") => {
                                if let Some(Some(acc)) = blocks.get_mut(idx) {
                                    if let Some(p) =
                                        delta.get("partial_json").and_then(|x| x.as_str())
                                    {
                                        acc.args.push_str(p);
                                    }
                                }
                            }
                            _ => {}
                        }
                    }
                }
                Some("message_delta") => {
                    if let Some(fr) = v
                        .get("delta")
                        .and_then(|d| d.get("stop_reason"))
                        .and_then(|x| x.as_str())
                    {
                        out.finish = map_finish(fr).to_string();
                    }
                    if let Some(o) = v
                        .get("usage")
                        .and_then(|u| u.get("output_tokens"))
                        .and_then(|x| x.as_i64())
                    {
                        out.tokens_out = o as i32;
                    }
                }
                _ => {}
            }
        }
    }

    out.tool_calls = blocks
        .into_iter()
        .flatten()
        .filter(|t| !t.name.is_empty())
        .map(|t| ToolCall {
            id: t.id,
            name: t.name,
            arguments: if t.args.trim().is_empty() {
                "{}".to_string()
            } else {
                t.args
            },
        })
        .collect();
    if out.finish.is_empty() {
        out.finish = if out.tool_calls.is_empty() {
            "end_turn".into()
        } else {
            "tool_use".into()
        };
    }
    Ok(out)
}

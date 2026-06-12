//! Google Gemini adapter (`generateContent` / `streamGenerateContent`). Like the
//! Anthropic one, it translates the chat loop's OpenAI-shaped messages/tools into
//! Gemini's `contents`/`functionDeclarations` shape and maps the streamed
//! response back into our shared `CallResult`. Auth is a `?key=` query param.

use std::collections::HashMap;

use futures::StreamExt;
use serde_json::{json, Value};

use super::{CallResult, SseSender, ToolCall};

pub const DEFAULT_BASE_URL: &str = "https://generativelanguage.googleapis.com";
// Gemini wants an output cap; generous so long answers aren't truncated.
const DEFAULT_MAX_TOKENS: u32 = 8192;

fn base(b: Option<&str>) -> &str {
    b.map(str::trim).filter(|s| !s.is_empty()).unwrap_or(DEFAULT_BASE_URL)
}

fn sse(tx: &SseSender, payload: Value) {
    let _ = tx.unbounded_send(Ok(bytes::Bytes::from(format!("data: {payload}\n\n"))));
}

fn map_finish(reason: &str) -> &'static str {
    match reason {
        "STOP" => "end_turn",
        "MAX_TOKENS" => "max_tokens",
        "SAFETY" | "RECITATION" | "BLOCKLIST" | "PROHIBITED_CONTENT" => "refusal",
        _ => "end_turn",
    }
}

/// Append parts to the last content if it shares `role`, else push a new one —
/// keeps tool results batched into a single user turn.
fn push_content(out: &mut Vec<Value>, role: &str, mut parts: Vec<Value>) {
    if let Some(last) = out.last_mut() {
        if last.get("role").and_then(|r| r.as_str()) == Some(role) {
            if let Some(arr) = last.get_mut("parts").and_then(|p| p.as_array_mut()) {
                arr.append(&mut parts);
                return;
            }
        }
    }
    out.push(json!({ "role": role, "parts": parts }));
}

/// Wrap a tool result string as a Gemini `functionResponse.response` object.
fn response_obj(content: &str) -> Value {
    match serde_json::from_str::<Value>(content) {
        Ok(v) if v.is_object() => v,
        Ok(v) => json!({ "result": v }),
        Err(_) => json!({ "result": content }),
    }
}

/// A user message's content → Gemini parts. Plain string → one text part; a
/// multimodal array maps text through and turns our canonical
/// `{type:"image", url, media_type}` into a `fileData` part referencing the
/// public (Bunny CDN) URL.
///
/// NOTE: `fileData.fileUri` is reliably resolved for Google-hosted URIs (Files
/// API / GCS). Arbitrary public URLs may not be fetched by Gemini in all
/// regions; if that proves flaky, switch to `inlineData` with base64 (requires
/// fetching the bytes server-side first). DeepSeek/OpenAI/Anthropic take the URL
/// directly, so they're the recommended vision providers here.
fn user_parts(content: Option<&Value>) -> Vec<Value> {
    match content {
        Some(Value::Array(blocks)) => {
            let mut parts: Vec<Value> = Vec::with_capacity(blocks.len());
            for b in blocks {
                match b.get("type").and_then(|t| t.as_str()) {
                    Some("text") => {
                        let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                        parts.push(json!({ "text": text }));
                    }
                    Some("image") => {
                        let url = b.get("url").and_then(|u| u.as_str()).unwrap_or("");
                        let mt = b
                            .get("media_type")
                            .and_then(|m| m.as_str())
                            .unwrap_or("image/png");
                        parts.push(json!({
                            "fileData": { "mimeType": mt, "fileUri": url }
                        }));
                    }
                    _ => {}
                }
            }
            parts
        }
        Some(Value::String(s)) => vec![json!({ "text": s })],
        _ => vec![json!({ "text": "" })],
    }
}

/// OpenAI-shaped messages → (systemInstruction text, Gemini `contents`).
fn translate_messages(messages: &[Value]) -> (String, Vec<Value>) {
    let mut system = String::new();
    let mut out: Vec<Value> = Vec::new();
    // tool_call_id → function name, so a later tool result can name its call.
    let mut call_names: HashMap<String, String> = HashMap::new();

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
            "tool" => {
                let id = m.get("tool_call_id").and_then(|v| v.as_str()).unwrap_or("");
                let content = m.get("content").and_then(|c| c.as_str()).unwrap_or("");
                let name = call_names.get(id).cloned().unwrap_or_default();
                push_content(
                    &mut out,
                    "user",
                    vec![json!({
                        "functionResponse": { "name": name, "response": response_obj(content) }
                    })],
                );
            }
            "assistant" => {
                let mut parts: Vec<Value> = Vec::new();
                if let Some(t) = m.get("content").and_then(|c| c.as_str()) {
                    if !t.is_empty() {
                        parts.push(json!({ "text": t }));
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
                        let parsed: Value =
                            serde_json::from_str(args).unwrap_or_else(|_| json!({}));
                        call_names.insert(id.to_string(), name.to_string());
                        parts.push(json!({ "functionCall": { "name": name, "args": parsed } }));
                    }
                }
                if parts.is_empty() {
                    parts.push(json!({ "text": " " }));
                }
                push_content(&mut out, "model", parts);
            }
            _ => {
                push_content(&mut out, "user", user_parts(m.get("content")));
            }
        }
    }
    (system, out)
}

/// OpenAI `function` tool schemas → a single Gemini `functionDeclarations` tool.
fn translate_tools(tools: &[Value]) -> Vec<Value> {
    let decls: Vec<Value> = tools
        .iter()
        .filter_map(|t| t.get("function"))
        .map(|f| {
            json!({
                "name": f.get("name").cloned().unwrap_or(Value::Null),
                "description": f.get("description").cloned().unwrap_or_else(|| json!("")),
                "parameters": f.get("parameters").cloned().unwrap_or_else(|| json!({ "type": "object" })),
            })
        })
        .collect();
    if decls.is_empty() {
        vec![]
    } else {
        vec![json!({ "function_declarations": decls })]
    }
}

fn build_body(system: &str, contents: Vec<Value>, tools: &[Value], max_tokens: u32) -> Value {
    let mut body = json!({
        "contents": contents,
        "generationConfig": { "maxOutputTokens": max_tokens },
    });
    if !system.trim().is_empty() {
        body["systemInstruction"] = json!({ "parts": [{ "text": system }] });
    }
    let decls = translate_tools(tools);
    if !decls.is_empty() {
        body["tools"] = json!(decls);
    }
    body
}

/// Concatenate the non-thought text parts of a Gemini candidate.
fn candidate_text(v: &Value) -> String {
    v.get("candidates")
        .and_then(|c| c.get(0))
        .and_then(|c| c.get("content"))
        .and_then(|c| c.get("parts"))
        .and_then(|p| p.as_array())
        .map(|parts| {
            parts
                .iter()
                .filter(|p| p.get("thought").and_then(|t| t.as_bool()) != Some(true))
                .filter_map(|p| p.get("text").and_then(|t| t.as_str()))
                .collect::<Vec<_>>()
                .join("")
        })
        .unwrap_or_default()
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
    let url = format!("{base}/v1beta/models/{model}:generateContent");
    let (system, contents) = translate_messages(messages);
    let body = build_body(&system, contents, &[], max_tokens);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .query(&[("key", api_key)])
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("gemini HTTP {status}: {body}"));
    }

    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("gemini decode failed: {e}"))?;
    Ok(candidate_text(&v))
}

/// One streaming model round. Parses Gemini SSE chunks into `CallResult`,
/// forwarding text/thinking deltas as our own SSE frames.
pub async fn call(
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    tx: &SseSender,
) -> Result<CallResult, String> {
    let base = base(base_url).trim_end_matches('/');
    let url = format!("{base}/v1beta/models/{model}:streamGenerateContent");
    let (system, contents) = translate_messages(messages);
    let body = build_body(&system, contents, tools, DEFAULT_MAX_TOKENS);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .query(&[("alt", "sse"), ("key", api_key)])
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("gemini HTTP {status}: {body}"));
    }

    let mut out = CallResult::default();
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("gemini stream error: {e}"))?;
        buf.push_str(&String::from_utf8_lossy(&chunk));

        while let Some(nl) = buf.find('\n') {
            let line = buf[..nl].trim().to_string();
            buf.drain(..=nl);
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

            if let Some(cand) = v.get("candidates").and_then(|c| c.get(0)) {
                if let Some(parts) = cand
                    .get("content")
                    .and_then(|c| c.get("parts"))
                    .and_then(|p| p.as_array())
                {
                    for p in parts {
                        if let Some(fc) = p.get("functionCall") {
                            let name = fc.get("name").and_then(|n| n.as_str()).unwrap_or("");
                            let args = fc.get("args").cloned().unwrap_or_else(|| json!({}));
                            out.tool_calls.push(ToolCall {
                                id: format!("call-{}", out.tool_calls.len()),
                                name: name.to_string(),
                                arguments: args.to_string(),
                            });
                        } else if let Some(t) = p.get("text").and_then(|t| t.as_str()) {
                            if t.is_empty() {
                                continue;
                            }
                            if p.get("thought").and_then(|x| x.as_bool()) == Some(true) {
                                out.thinking.push_str(t);
                                sse(tx, json!({ "type": "thinking", "delta": t }));
                            } else {
                                out.text.push_str(t);
                                sse(tx, json!({ "type": "text", "delta": t }));
                            }
                        }
                    }
                }
                if let Some(fr) = cand.get("finishReason").and_then(|x| x.as_str()) {
                    out.finish = map_finish(fr).to_string();
                }
            }

            if let Some(u) = v.get("usageMetadata") {
                let prompt = u.get("promptTokenCount").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
                let cached = u
                    .get("cachedContentTokenCount")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0) as i32;
                out.tokens_cached = cached;
                out.tokens_in = (prompt - cached).max(0);
                out.tokens_out =
                    u.get("candidatesTokenCount").and_then(|x| x.as_i64()).unwrap_or(0) as i32;
            }
        }
    }

    out.tool_calls.retain(|t| !t.name.is_empty());
    // Gemini reports finishReason STOP even when returning a functionCall, so
    // let tool presence override the stop reason for the agent loop.
    if !out.tool_calls.is_empty() {
        out.finish = "tool_use".into();
    } else if out.finish.is_empty() {
        out.finish = "end_turn".into();
    }
    Ok(out)
}

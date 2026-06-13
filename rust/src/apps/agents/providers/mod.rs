//! Provider adapters + a thin dispatch layer. Each provider is a fully
//! standalone module (`deepseek`, `openai`, `minimax`, `anthropic`, `gemini`)
//! that owns its own wire format, base URL, and quirks. Callers go through
//! `call`/`complete` here with the provider `kind`; the only shared pieces are
//! the `CallResult`/`ToolCall`/`SseSender` types that keep the chat loop
//! adapter-agnostic.

pub mod anthropic;
pub mod catalog;
pub mod deepseek;
pub mod gemini;
pub mod minimax;
pub mod openai;

use bytes::Bytes;
use futures::channel::mpsc::UnboundedSender;
use serde_json::{json, Value};

pub type SseSender = UnboundedSender<Result<Bytes, actix_web::Error>>;

/// Inside the Docker backend, `localhost`/`127.0.0.1` in a provider base URL
/// means the container itself — not the host where LM Studio / Ollama run. We
/// rewrite those to the docker host gateway so a user can enter the intuitive
/// `localhost` URL. `host.docker.internal` is provided by docker-compose
/// `extra_hosts`. No-op for any non-local URL (cloud providers never use it).
pub(crate) fn reach_host(url: &str) -> String {
    url.replace("://localhost", "://host.docker.internal")
        .replace("://127.0.0.1", "://host.docker.internal")
}

#[derive(Debug, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub arguments: String,
}

/// One model round's accumulated output, normalised across providers.
#[derive(Default)]
pub struct CallResult {
    pub text: String,
    pub thinking: String,
    pub tool_calls: Vec<ToolCall>,
    pub finish: String,
    pub tokens_in: i32,
    pub tokens_out: i32,
    /// Cache-read input tokens (served from prompt cache, billed cheaply).
    pub tokens_cached: i32,
    /// Cache-creation input tokens (Anthropic only; billed ~1.25x). Other
    /// providers don't surface a separate write count, so this stays 0.
    pub tokens_cache_write: i32,
}

/// Whether the chat loop can drive this provider kind. `lmstudio` and `ollama`
/// are local OpenAI-compatible runtimes — they ride the `openai` adapter, just
/// with a user-supplied `base_url`.
pub fn supported(kind: &str) -> bool {
    matches!(
        kind,
        "deepseek" | "openai" | "minimax" | "anthropic" | "gemini" | "lmstudio" | "ollama"
    )
}

/// One non-streaming completion (utility calls: titles, dialectic, NLI).
pub async fn complete(
    kind: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Result<String, String> {
    match kind {
        "openai" | "lmstudio" | "ollama" => {
            openai::complete(api_key, base_url, model, messages, max_tokens).await
        }
        "minimax" => minimax::complete(api_key, base_url, model, messages, max_tokens).await,
        "anthropic" => anthropic::complete(api_key, base_url, model, messages, max_tokens).await,
        "gemini" => gemini::complete(api_key, base_url, model, messages, max_tokens).await,
        _ => deepseek::complete(api_key, base_url, model, messages, max_tokens).await,
    }
}

/// Like `complete`, but also returns `(tokens_in, tokens_out)` so callers can
/// log to the token-usage ledger. Exact for the OpenAI-compatible providers
/// (counts from the response `usage` block); for Anthropic/Gemini it falls back
/// to a rough char/4 estimate (their `complete` doesn't surface usage here).
pub async fn complete_usage(
    kind: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    max_tokens: u32,
) -> Result<(String, i32, i32), String> {
    match kind {
        "openai" | "lmstudio" | "ollama" => {
            openai::complete_usage(api_key, base_url, model, messages, max_tokens).await
        }
        "minimax" => minimax::complete_usage(api_key, base_url, model, messages, max_tokens).await,
        "anthropic" | "gemini" => {
            let text = complete(kind, api_key, base_url, model, messages, max_tokens).await?;
            let (tin, tout) = (estimate_tokens(messages), estimate_str(&text));
            Ok((text, tin, tout))
        }
        _ => deepseek::complete_usage(api_key, base_url, model, messages, max_tokens).await,
    }
}

/// Normalise chat-loop messages into OpenAI `/chat/completions` shape. Only
/// touches messages whose `content` is a block array (our multimodal user
/// turns) — text-only messages (the common case) pass through unchanged.
/// Canonical `{type:"image", url}` blocks become OpenAI `{type:"image_url"}`.
pub(crate) fn to_openai_messages(messages: &[Value]) -> Vec<Value> {
    messages
        .iter()
        .map(|m| {
            if m.get("content").map(|c| c.is_array()).unwrap_or(false) {
                let mut m = m.clone();
                m["content"] = to_openai_content(&m["content"]);
                m
            } else {
                m.clone()
            }
        })
        .collect()
}

fn to_openai_content(content: &Value) -> Value {
    let Value::Array(blocks) = content else {
        return content.clone();
    };
    let mut out = Vec::with_capacity(blocks.len());
    for b in blocks {
        match b.get("type").and_then(|t| t.as_str()) {
            Some("text") => {
                let text = b.get("text").and_then(|t| t.as_str()).unwrap_or("");
                out.push(json!({ "type": "text", "text": text }));
            }
            Some("image") => {
                let url = b.get("url").and_then(|u| u.as_str()).unwrap_or("");
                out.push(json!({ "type": "image_url", "image_url": { "url": url } }));
            }
            _ => {}
        }
    }
    Value::Array(out)
}

/// Rough token estimate (~4 chars/token) over a message array's string content.
fn estimate_tokens(messages: &[Value]) -> i32 {
    let chars: usize = messages
        .iter()
        .filter_map(|m| m.get("content").and_then(|c| c.as_str()))
        .map(|s| s.chars().count())
        .sum();
    (chars / 4) as i32
}

fn estimate_str(s: &str) -> i32 {
    (s.chars().count() / 4) as i32
}

/// One streaming model round. `messages`/`tools` are OpenAI-shaped JSON; the
/// Anthropic and Gemini adapters translate them internally.
pub async fn call(
    kind: &str,
    api_key: &str,
    base_url: Option<&str>,
    model: &str,
    messages: &[Value],
    tools: &[Value],
    tx: &SseSender,
) -> Result<CallResult, String> {
    match kind {
        "openai" | "lmstudio" | "ollama" => {
            openai::call(api_key, base_url, model, messages, tools, tx).await
        }
        "minimax" => minimax::call(api_key, base_url, model, messages, tools, tx).await,
        "anthropic" => anthropic::call(api_key, base_url, model, messages, tools, tx).await,
        "gemini" => gemini::call(api_key, base_url, model, messages, tools, tx).await,
        _ => deepseek::call(api_key, base_url, model, messages, tools, tx).await,
    }
}

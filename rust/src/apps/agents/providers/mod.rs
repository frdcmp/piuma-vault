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
use serde_json::Value;

pub type SseSender = UnboundedSender<Result<Bytes, actix_web::Error>>;

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
}

/// Whether the chat loop can drive this provider kind.
pub fn supported(kind: &str) -> bool {
    matches!(kind, "deepseek" | "openai" | "minimax" | "anthropic" | "gemini")
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
        "openai" => openai::complete(api_key, base_url, model, messages, max_tokens).await,
        "minimax" => minimax::complete(api_key, base_url, model, messages, max_tokens).await,
        "anthropic" => anthropic::complete(api_key, base_url, model, messages, max_tokens).await,
        "gemini" => gemini::complete(api_key, base_url, model, messages, max_tokens).await,
        _ => deepseek::complete(api_key, base_url, model, messages, max_tokens).await,
    }
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
        "openai" => openai::call(api_key, base_url, model, messages, tools, tx).await,
        "minimax" => minimax::call(api_key, base_url, model, messages, tools, tx).await,
        "anthropic" => anthropic::call(api_key, base_url, model, messages, tools, tx).await,
        "gemini" => gemini::call(api_key, base_url, model, messages, tools, tx).await,
        _ => deepseek::call(api_key, base_url, model, messages, tools, tx).await,
    }
}

use serde::{Deserialize, Serialize};
use serde_json::Value;
use uuid::Uuid;

/// Open (or resume) a voice session. Omitting `conversation_id` starts a new
/// voice conversation; passing one continues it (and is how the client
/// reconnects when the provider rotates the connection). `resume_handle` is the
/// provider's session-resumption handle from the previous connection.
#[derive(Debug, Deserialize)]
pub struct StartSessionReq {
    pub conversation_id: Option<Uuid>,
    pub timezone: Option<String>,
    pub client_now: Option<String>,
    pub resume_handle: Option<String>,
}

/// Everything the client needs to talk to the provider directly: the WebSocket
/// URL (carrying a short-lived token, never the API key) and the exact `setup`
/// message to send first.
#[derive(Debug, Serialize)]
pub struct StartSessionResp {
    pub conversation_id: Uuid,
    pub provider: String,
    pub model: String,
    pub ws_url: String,
    pub setup: Value,
    /// When set, Piuma only answers when addressed with this phrase (see
    /// `prompt::REQUIRE_WAKE_PHRASE`); clients show it as a hint.
    pub wake_phrase: Option<String>,
}

/// A tool call the model made, relayed by the client for the backend to run.
#[derive(Debug, Deserialize)]
pub struct ToolReq {
    pub conversation_id: Uuid,
    pub name: String,
    #[serde(default)]
    pub args: Value,
}

/// One finished spoken turn, persisted as a normal chat message.
#[derive(Debug, Deserialize)]
pub struct TurnReq {
    pub conversation_id: Uuid,
    /// "user" | "assistant"
    pub role: String,
    pub text: String,
    /// Tools the model ran during an assistant turn, in call order.
    #[serde(default)]
    pub tools: Vec<TurnTool>,
    /// The user barged in before the assistant finished speaking.
    #[serde(default)]
    pub interrupted: bool,
    /// Assistant turns: the provider's token usage for this exchange, summed
    /// from its usage reports.
    #[serde(default)]
    pub tokens_input: Option<i32>,
    #[serde(default)]
    pub tokens_output: Option<i32>,
    /// The audio part of `tokens_input` / `tokens_output` (billed at the audio
    /// rate; the rest is text).
    #[serde(default)]
    pub tokens_input_audio: Option<i32>,
    #[serde(default)]
    pub tokens_output_audio: Option<i32>,
    /// Assistant turns: ms from the end of your speech to Piuma's first audio,
    /// as measured in the browser.
    #[serde(default)]
    pub latency_ms: Option<u32>,
}

#[derive(Debug, Deserialize)]
pub struct TurnTool {
    pub name: String,
    #[serde(default)]
    pub input: Value,
    #[serde(default)]
    pub output: Value,
}

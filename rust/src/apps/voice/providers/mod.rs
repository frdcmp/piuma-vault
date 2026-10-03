//! Speech-to-speech provider adapters, dispatched by provider `kind`.

use serde_json::Value;

pub mod gemini;

/// What a voice session is configured with — built by the backend and locked
/// into the provider token, so the client can't change prompt or tools.
pub struct SessionSpec<'a> {
    pub model: &'a str,
    /// Provider voice name; `None` = provider default.
    pub voice: Option<&'a str>,
    pub system: &'a str,
    /// OpenAI-format tool schemas (`agents::tools::schemas_for`).
    pub tools: &'a [Value],
    /// Resumption handle from the previous connection of the same session.
    pub resume_handle: Option<&'a str>,
}

/// A minted session: where the client connects (URL carries a short-lived
/// token, never the API key) and the first message it must send.
pub struct StartedSession {
    pub ws_url: String,
    pub setup: Value,
}

pub async fn start_session(
    kind: &str,
    api_key: &str,
    spec: &SessionSpec<'_>,
) -> Result<StartedSession, String> {
    match kind {
        "gemini" => gemini::start_session(api_key, spec).await,
        other => Err(format!("unknown voice provider: {other}")),
    }
}

/// The models `kind` exposes that can drive a realtime voice session.
pub async fn list_models(kind: &str, api_key: &str) -> Result<Vec<String>, String> {
    match kind {
        "gemini" => gemini::list_models(api_key).await,
        other => Err(format!("unknown voice provider: {other}")),
    }
}

/// Credential + model check for the Services "try now" button.
pub async fn test(kind: &str, api_key: &str, model: &str) -> Result<String, String> {
    match kind {
        "gemini" => gemini::test(api_key, model).await,
        other => Err(format!("unknown voice provider: {other}")),
    }
}

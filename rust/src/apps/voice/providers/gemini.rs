//! Google Gemini Live API (speech-to-speech over the `BidiGenerateContent`
//! WebSocket). Live-capable models advertise `bidiGenerateContent` in their
//! `supportedGenerationMethods`.
//!
//! Sessions use ephemeral tokens: the backend mints one with the whole `setup`
//! (model, voice, system instruction, tools, VAD…) locked in, and the browser
//! connects to the `BidiGenerateContentConstrained` endpoint with it. With no
//! `fieldMask` the token's setup is used entirely and the client's is ignored.

use std::time::Duration;

use chrono::Utc;
use serde_json::{json, Value};

use super::{SessionSpec, StartedSession};

const BASE: &str = "https://generativelanguage.googleapis.com";
const WS_CONSTRAINED: &str = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained";
const LIVE_METHOD: &str = "bidiGenerateContent";
/// How long the token stays usable (including resumptions of its session).
const TOKEN_TTL_MIN: i64 = 30;
/// How long the browser has to open the session after minting.
const NEW_SESSION_TTL_SEC: i64 = 60;
/// Silence that ends your turn. Google recommends 500–800 ms; lower = snappier.
const SILENCE_MS: u32 = 500;

fn http() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

/// The `setup` message for `spec` (also what the token locks).
fn build_setup(spec: &SessionSpec<'_>) -> Value {
    let mut generation = json!({ "responseModalities": ["AUDIO"] });
    if let Some(voice) = spec.voice.filter(|v| !v.trim().is_empty()) {
        generation["speechConfig"] =
            json!({ "voiceConfig": { "prebuiltVoiceConfig": { "voiceName": voice.trim() } } });
    }
    let declarations: Vec<Value> = spec
        .tools
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
    let mut resumption = json!({});
    if let Some(handle) = spec.resume_handle.filter(|h| !h.is_empty()) {
        resumption["handle"] = json!(handle);
    }
    let mut setup = json!({
        "model": format!("models/{}", spec.model),
        "generationConfig": generation,
        "systemInstruction": { "parts": [{ "text": spec.system }] },
        "inputAudioTranscription": {},
        "outputAudioTranscription": {},
        "realtimeInputConfig": {
            "automaticActivityDetection": { "silenceDurationMs": SILENCE_MS },
            "activityHandling": "START_OF_ACTIVITY_INTERRUPTS",
        },
        "sessionResumption": resumption,
        // Sliding-window compression lifts the ~15 min audio session cap.
        "contextWindowCompression": { "slidingWindow": {} },
    });
    if !declarations.is_empty() {
        setup["tools"] = json!([{ "functionDeclarations": declarations }]);
    }
    setup
}

/// Mint a single-use token with the setup locked in.
pub async fn start_session(api_key: &str, spec: &SessionSpec<'_>) -> Result<StartedSession, String> {
    let setup = build_setup(spec);
    let now = Utc::now();
    let body = json!({
        "uses": 1,
        "expireTime": (now + chrono::Duration::minutes(TOKEN_TTL_MIN)).to_rfc3339(),
        "newSessionExpireTime": (now + chrono::Duration::seconds(NEW_SESSION_TTL_SEC)).to_rfc3339(),
        "bidiGenerateContentSetup": setup,
    });
    let resp = http()?
        .post(format!("{BASE}/v1beta/auth_tokens"))
        .header("x-goog-api-key", api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini token request failed: {e}"))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("gemini token: bad response: {e}"))?;
    if !status.is_success() {
        let msg = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown error");
        return Err(format!("gemini token: HTTP {status} — {msg}"));
    }
    let token = v
        .get("name")
        .and_then(|n| n.as_str())
        .ok_or("gemini token: response has no token name")?;
    let ws_url = format!("{WS_CONSTRAINED}?access_token={}", urlencoding::encode(token));
    Ok(StartedSession {
        ws_url,
        setup: json!({ "setup": setup }),
    })
}

/// All models visible to the key, as raw JSON objects.
async fn fetch_models(api_key: &str) -> Result<Vec<Value>, String> {
    let resp = http()?
        .get(format!("{BASE}/v1beta/models"))
        .header("x-goog-api-key", api_key)
        .query(&[("pageSize", "1000")])
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("gemini: bad response: {e}"))?;
    if !status.is_success() {
        let msg = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown error");
        return Err(format!("gemini: HTTP {status} — {msg}"));
    }
    Ok(v.get("models")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default())
}

/// Model ids (without the `models/` prefix) that support the Live API.
pub async fn list_models(api_key: &str) -> Result<Vec<String>, String> {
    Ok(fetch_models(api_key)
        .await?
        .iter()
        .filter(|m| {
            m.get("supportedGenerationMethods")
                .and_then(|s| s.as_array())
                .is_some_and(|a| a.iter().any(|x| x.as_str() == Some(LIVE_METHOD)))
        })
        .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
        .map(|n| n.strip_prefix("models/").unwrap_or(n).to_string())
        .collect())
}

/// The key is valid and `model` is a Live-capable model it can reach.
pub async fn test(api_key: &str, model: &str) -> Result<String, String> {
    let live = list_models(api_key).await?;
    if live.iter().any(|m| m == model) {
        Ok(format!("OK — key valid, {model} supports Gemini Live"))
    } else if live.is_empty() {
        Err("key valid, but it can reach no Live-capable models".to_string())
    } else {
        Err(format!(
            "key valid, but {model} is not a Live model for this key — try: {}",
            live.join(", ")
        ))
    }
}

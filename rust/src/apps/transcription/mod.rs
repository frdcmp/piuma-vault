//! Provider-agnostic streaming transcription. A thin dispatch layer over the
//! per-provider adapters in `providers/`, mirroring `apps::web_search` and
//! `apps::agents::providers`: callers pass the provider `kind` and go through
//! `connect`/`parse`/`audio_format`/`test`. The active provider + its API key
//! live in `app_settings` (admin → Services); see `config_for`.
//!
//! `recorder` is the only orchestration consumer — it opens a session, bridges
//! browser PCM frames to the upstream socket, and persists normalized segments.

pub mod models;
pub mod providers;

use crate::apps::settings::store;
use crate::db::db::DbPool;
use models::{AudioFormat, TranscriberConfig, TranscriptSegment};

/// The connected upstream WebSocket (TLS) handed back to the relay. Aliased so
/// callers don't depend on `tokio_tungstenite` types directly.
pub type UpstreamWs = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

const DEFAULT_PROVIDER: &str = "speechmatics";

/// Whether the recorder can drive this provider kind.
pub fn supported(kind: &str) -> bool {
    matches!(kind, "speechmatics")
}

/// The audio encoding the browser/relay must send for `kind`.
pub fn audio_format(kind: &str) -> AudioFormat {
    match kind {
        _ => providers::speechmatics::audio_format(),
    }
}

/// Open an authenticated upstream session for `kind`, ready to receive PCM
/// frames and emit transcript messages.
pub async fn connect(kind: &str, cfg: &TranscriberConfig) -> Result<UpstreamWs, String> {
    match kind {
        "speechmatics" => providers::speechmatics::connect(cfg).await,
        other => Err(format!("unknown transcription provider: {other}")),
    }
}

/// Normalize one upstream message into segments (None for control frames).
pub fn parse(kind: &str, raw: &str) -> Option<Vec<TranscriptSegment>> {
    match kind {
        _ => providers::speechmatics::parse(raw),
    }
}

/// The "flush and finish" message for `kind`; `seq` is the count of audio
/// chunks forwarded.
pub fn end_message(kind: &str, seq: u64) -> String {
    match kind {
        _ => providers::speechmatics::end_message(seq),
    }
}

/// Resolve the active provider + its saved API key from settings. Errors with a
/// dashboard-friendly message if unset.
pub async fn config_for(pool: &DbPool) -> Result<TranscriberConfig, String> {
    let provider = store::get(pool, store::TRANSCRIPTION_PROVIDER)
        .await
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let api_key = key_for(pool, &provider).await?;
    Ok(TranscriberConfig {
        provider,
        api_key,
        language: None,
    })
}

/// The saved API key for a given provider, or a helpful error.
pub async fn key_for(pool: &DbPool, provider: &str) -> Result<String, String> {
    let opt = match provider {
        "speechmatics" => store::get(pool, store::TRANSCRIPTION_SPEECHMATICS_API_KEY).await,
        "assemblyai" => store::get(pool, store::TRANSCRIPTION_ASSEMBLYAI_API_KEY).await,
        "deepgram" => store::get(pool, store::TRANSCRIPTION_DEEPGRAM_API_KEY).await,
        other => return Err(format!("unknown transcription provider: {other}")),
    };
    opt.ok_or_else(|| format!("{provider} API key not set — add it in admin → Services"))
}

/// Live credential check used by the Services "test" button: mint a session
/// token (the cheapest call that proves the key works) without opening a stream.
pub async fn test(provider: &str, api_key: &str) -> Result<String, String> {
    match provider {
        "speechmatics" => {
            let _token = providers::speechmatics::session_token(api_key).await?;
            Ok("OK — Speechmatics key valid (minted a session token)".to_string())
        }
        other => Err(format!("test not implemented for provider: {other}")),
    }
}

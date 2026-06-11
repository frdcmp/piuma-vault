//! Normalized transcription types, shared across provider adapters. Each
//! provider speaks its own wire format; the adapter translates into these so
//! the `recorder` app never sees provider-specific JSON.

use serde::{Deserialize, Serialize};

/// One finalized (or partial) chunk of transcript, normalized across providers.
/// `t`/`end` are seconds from the start of the stream. `speaker` is populated
/// only when the provider/tier supports diarization (e.g. Speechmatics Pro).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TranscriptSegment {
    /// Start time in seconds from stream start.
    #[serde(rename = "t")]
    pub start: f64,
    /// End time in seconds from stream start.
    pub end: f64,
    /// Speaker label (e.g. "S1") when diarization is available.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub speaker: Option<String>,
    /// Whether this is a final segment (`true`) or a live partial (`false`).
    /// Only finals are persisted to the JSONL log; partials drive the live UI.
    pub is_final: bool,
    /// The transcribed text for this segment.
    pub text: String,
}

/// The PCM/audio encoding a provider expects on its streaming socket. The
/// browser capture (AudioWorklet) and the relay must produce exactly this.
#[derive(Debug, Clone, Serialize)]
pub struct AudioFormat {
    /// e.g. "pcm_s16le" (raw little-endian 16-bit PCM).
    pub encoding: String,
    /// e.g. 16000.
    pub sample_rate: u32,
}

/// Resolved config for opening a transcription session: which provider, its
/// API key (long-lived; the adapter exchanges it for a session token if
/// needed), and the spoken language hint.
#[derive(Debug, Clone)]
pub struct TranscriberConfig {
    pub provider: String,
    pub api_key: String,
    /// BCP-47-ish language code, e.g. "en". Providers may auto-detect if unset.
    pub language: Option<String>,
}

//! Speechmatics real-time streaming adapter.
//!
//! Flow: the long-lived API key is first exchanged for a short-lived JWT
//! (`session_token`); we then open the WS to the RT endpoint with that JWT,
//! send a `StartRecognition` config message, and stream raw PCM16 frames. The
//! server replies with `AddTranscript` (final) / `AddPartialTranscript` (live)
//! messages, which `parse` normalizes into `TranscriptSegment`s.
//!
//! Docs: https://docs.speechmatics.com/rt-api-ref

use serde_json::{json, Value};

use crate::apps::transcription::models::{AudioFormat, TranscriberConfig, TranscriptSegment};
use crate::apps::transcription::UpstreamWs;

/// Management API: mint a short-lived RT key from the long-lived API key.
const MGMT_TOKEN_URL: &str = "https://mp.speechmatics.com/v1/api_keys?type=rt";
/// Real-time streaming WS endpoint (EU region).
const RT_WS_URL: &str = "wss://eu2.rt.speechmatics.com/v2";
/// Temp-token TTL in seconds.
const TOKEN_TTL_SECS: u32 = 3600;
/// Sample rate we ask the browser to produce and tell Speechmatics to expect.
pub const SAMPLE_RATE: u32 = 16_000;

/// The audio encoding the browser/relay must send for this provider.
pub fn audio_format() -> AudioFormat {
    AudioFormat {
        encoding: "pcm_s16le".to_string(),
        sample_rate: SAMPLE_RATE,
    }
}

/// Exchange the long-lived API key for a short-lived RT JWT. The browser never
/// sees the long-lived key — only this temp token crosses into the WS handshake.
pub async fn session_token(api_key: &str) -> Result<String, String> {
    let client = reqwest::Client::new();
    let resp = client
        .post(MGMT_TOKEN_URL)
        .bearer_auth(api_key)
        .json(&json!({ "ttl": TOKEN_TTL_SECS }))
        .send()
        .await
        .map_err(|e| format!("speechmatics token request failed: {e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("speechmatics token HTTP {status}: {body}"));
    }
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("speechmatics token decode failed: {e}"))?;
    v.get("key_value")
        .and_then(|k| k.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| "speechmatics token response missing key_value".to_string())
}

/// Open the upstream WS, authenticate with a fresh session token, and send the
/// `StartRecognition` config. Returns a stream ready to receive binary PCM
/// frames (forwarded by the relay) and to emit transcript messages.
pub async fn connect(cfg: &TranscriberConfig) -> Result<UpstreamWs, String> {
    let token = session_token(&cfg.api_key).await?;
    let url = format!("{RT_WS_URL}?jwt={token}");

    let (mut ws, _resp) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("speechmatics WS connect failed: {e}"))?;

    // Tell Speechmatics the audio shape + transcription config. Partials power
    // the live UI; finals are what we persist.
    let start = json!({
        "message": "StartRecognition",
        "audio_format": {
            "type": "raw",
            "encoding": "pcm_s16le",
            "sample_rate": SAMPLE_RATE,
        },
        "transcription_config": {
            "language": cfg.language.clone().unwrap_or_else(|| "en".to_string()),
            "operating_point": "enhanced",
            "enable_partials": true,
            // Diarization needs max_delay >= 2.0. Speaker labels (S1, S2, …) then
            // appear on each word's alternatives; `parse` splits per speaker.
            "max_delay": 2.0,
            "diarization": "speaker",
        },
    });

    use futures_util::SinkExt;
    ws.send(tokio_tungstenite::tungstenite::Message::Text(start.to_string()))
        .await
        .map_err(|e| format!("speechmatics StartRecognition send failed: {e}"))?;

    Ok(ws)
}

/// The `EndOfStream` message that flushes the final transcript. `seq` is the
/// number of audio chunks the relay forwarded.
pub fn end_message(seq: u64) -> String {
    json!({ "message": "EndOfStream", "last_seq_no": seq }).to_string()
}

/// Normalize one Speechmatics server message into segments. Returns `None` for
/// control frames (RecognitionStarted, AudioAdded, EndOfTranscript, …) that
/// carry no transcript text.
///
/// Walks the word-level `results` so that a message spanning multiple speakers
/// is split into one segment per speaker run. Punctuation (`type == "punctuation"`)
/// attaches to the preceding word without a leading space and never forces a
/// speaker switch. With diarization off, every word's speaker is `None`, so the
/// whole message collapses into a single segment (unchanged behaviour).
pub fn parse(raw: &str) -> Option<Vec<TranscriptSegment>> {
    let v: Value = serde_json::from_str(raw).ok()?;
    let kind = v.get("message").and_then(|m| m.as_str())?;
    let is_final = match kind {
        "AddTranscript" => true,
        "AddPartialTranscript" => false,
        _ => return None,
    };

    let results = v.get("results").and_then(|r| r.as_array())?;
    let mut segments: Vec<TranscriptSegment> = Vec::new();
    let mut cur: Option<TranscriptSegment> = None;

    for r in results {
        let is_punct = r.get("type").and_then(|t| t.as_str()) == Some("punctuation");
        let alt = r
            .get("alternatives")
            .and_then(|a| a.as_array())
            .and_then(|a| a.first());
        let content = alt
            .and_then(|a| a.get("content"))
            .and_then(|c| c.as_str())
            .unwrap_or("");
        if content.is_empty() {
            continue;
        }
        let start = r.get("start_time").and_then(|t| t.as_f64()).unwrap_or(0.0);
        let end = r.get("end_time").and_then(|t| t.as_f64()).unwrap_or(start);
        let speaker = alt
            .and_then(|a| a.get("speaker"))
            .and_then(|s| s.as_str())
            .filter(|s| !s.is_empty() && *s != "UU")
            .map(|s| s.to_string());

        match cur.as_mut() {
            // Same speaker, or punctuation (which clings to the prior word):
            // extend the current segment.
            Some(seg) if is_punct || seg.speaker == speaker => {
                if is_punct {
                    seg.text.push_str(content);
                } else {
                    seg.text.push(' ');
                    seg.text.push_str(content);
                }
                seg.end = end;
            }
            // Speaker changed (or first word): start a new segment.
            _ => {
                if let Some(seg) = cur.take() {
                    segments.push(seg);
                }
                cur = Some(TranscriptSegment {
                    start,
                    end,
                    speaker,
                    is_final,
                    text: content.to_string(),
                });
            }
        }
    }
    if let Some(seg) = cur.take() {
        segments.push(seg);
    }

    if segments.is_empty() {
        None
    } else {
        Some(segments)
    }
}

// ── batch: one recorded file ──────────────────────────────────────────────

/// Batch jobs (a whole file at once).
const BATCH_URL: &str = "https://asr.api.speechmatics.com/v2/jobs";

/// What a file said: its words, and the language they were heard in.
#[derive(Debug, Clone, PartialEq)]
pub struct Heard {
    pub text: String,
    pub language: String,
}

/// Why a file wasn't heard.
#[derive(Debug)]
pub enum Unheard {
    /// Speechmatics turned the job down (with `auto`: it couldn't tell the language)
    Rejected(String),
    /// the call itself failed: worth another try
    Failed(String),
}

/// Transcribe one recorded file (a voice note): `language` an ISO code, or None to detect it.
/// Waits for the job, up to `wait`.
pub async fn transcribe_file(api_key: &str, file: Vec<u8>, mime: &str, language: Option<&str>, wait: std::time::Duration) -> Result<Heard, Unheard> {
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(60)).build().map_err(|e| Unheard::Failed(e.to_string()))?;
    let config = json!({
        "type": "transcription",
        "transcription_config": { "language": language.unwrap_or("auto"), "operating_point": "enhanced" },
    });
    let part = reqwest::multipart::Part::bytes(file).file_name("audio").mime_str(mime.split(';').next().unwrap_or("audio/ogg").trim()).map_err(|e| Unheard::Failed(e.to_string()))?;
    let form = reqwest::multipart::Form::new().part("data_file", part).text("config", config.to_string());
    let resp = client.post(BATCH_URL).bearer_auth(api_key).multipart(form).send().await.map_err(|e| Unheard::Failed(format!("speechmatics: {e}")))?;
    let status = resp.status();
    let v: Value = resp.json().await.unwrap_or(Value::Null);
    let Some(id) = v["id"].as_str().map(str::to_string) else {
        return Err(Unheard::Failed(format!("speechmatics job HTTP {status}: {v}")));
    };
    let started = std::time::Instant::now();
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(2)).await;
        let job: Value = client
            .get(format!("{BATCH_URL}/{id}"))
            .bearer_auth(api_key)
            .send()
            .await
            .map_err(|e| Unheard::Failed(format!("speechmatics: {e}")))?
            .json()
            .await
            .unwrap_or(Value::Null);
        match job["job"]["status"].as_str() {
            Some("done") => break,
            Some("rejected") => return Err(Unheard::Rejected(job["job"]["errors"].to_string())),
            Some("running") | None if started.elapsed() < wait => continue,
            Some(other) => return Err(Unheard::Failed(format!("speechmatics job {id}: {other}"))),
            None => return Err(Unheard::Failed(format!("speechmatics job {id}: no answer"))),
        }
    }
    let t: Value = client
        .get(format!("{BATCH_URL}/{id}/transcript?format=json-v2"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| Unheard::Failed(format!("speechmatics: {e}")))?
        .json()
        .await
        .map_err(|e| Unheard::Failed(format!("speechmatics transcript: {e}")))?;
    let language = t["metadata"]["language_identification"]["predicted_language"]
        .as_str()
        .or(language)
        .or(t["metadata"]["transcription_config"]["language"].as_str())
        .unwrap_or("auto")
        .to_string();
    Ok(Heard { text: words(&t), language })
}

/// The words of a json-v2 transcript, punctuation attached.
fn words(t: &Value) -> String {
    let mut out = String::new();
    for r in t["results"].as_array().into_iter().flatten() {
        let Some(w) = r["alternatives"][0]["content"].as_str() else { continue };
        let attaches = r["type"] == "punctuation" || r["attaches_to"] == "previous";
        if !out.is_empty() && !attaches {
            out.push(' ');
        }
        out.push_str(w);
    }
    out
}

#[cfg(test)]
mod batch_tests {
    use super::*;

    #[test]
    fn punctuation_attaches() {
        let t = json!({ "results": [
            { "type": "word", "alternatives": [{ "content": "Aspetta" }] },
            { "type": "punctuation", "attaches_to": "previous", "alternatives": [{ "content": "," }] },
            { "type": "word", "alternatives": [{ "content": "ci" }] },
            { "type": "word", "alternatives": [{ "content": "provo" }] },
            { "type": "punctuation", "attaches_to": "previous", "alternatives": [{ "content": "." }] },
        ]});
        assert_eq!(words(&t), "Aspetta, ci provo.");
    }
}

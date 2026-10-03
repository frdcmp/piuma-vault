//! In-memory live-session registry + the S3 transcript flush.
//!
//! While a session streams, its finalized segments accumulate in a `LiveBuffer`
//! held both by the WS relay task and (via the registry) by status/stop
//! endpoints. On stop, `flush` writes the whole transcript to S3 as JSONL and
//! updates the DB index row. Audio is never buffered or stored — only text.

use std::collections::HashMap;
use std::sync::Arc;

use aws_sdk_s3::primitives::ByteStream;
use tokio::sync::{Mutex, Notify};
use uuid::Uuid;

use crate::apps::transcription::models::TranscriptSegment;
use crate::db::db::DbPool;

/// Accumulated state for one live session.
#[derive(Default)]
pub struct LiveBuffer {
    /// Finalized segments, in arrival order. Partials are never stored here.
    pub segments: Vec<TranscriptSegment>,
    /// Count of audio chunks forwarded upstream (for the provider's EndOfStream).
    pub audio_seq: u64,
}

/// Handle shared between the relay task and the REST endpoints.
#[derive(Clone)]
pub struct LiveHandle {
    pub buffer: Arc<Mutex<LiveBuffer>>,
    /// Fired by `POST /stop` to ask the relay task to finish gracefully.
    pub stop: Arc<Notify>,
}

impl LiveHandle {
    fn new() -> Self {
        Self {
            buffer: Arc::new(Mutex::new(LiveBuffer::default())),
            stop: Arc::new(Notify::new()),
        }
    }
}

/// Process-wide registry of active sessions. Cloned into app state.
#[derive(Clone, Default)]
pub struct SessionRegistry {
    inner: Arc<std::sync::Mutex<HashMap<Uuid, LiveHandle>>>,
}

impl SessionRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a fresh live session and return its handle.
    pub fn register(&self, id: Uuid) -> LiveHandle {
        let handle = LiveHandle::new();
        self.inner.lock().unwrap().insert(id, handle.clone());
        handle
    }

    /// Look up an active session (None once it has finished/flushed).
    pub fn get(&self, id: &Uuid) -> Option<LiveHandle> {
        self.inner.lock().unwrap().get(id).cloned()
    }

    pub fn remove(&self, id: &Uuid) {
        self.inner.lock().unwrap().remove(id);
    }
}

/// Serialize finalized segments to JSONL (one segment per line).
pub fn to_jsonl(segments: &[TranscriptSegment]) -> String {
    segments
        .iter()
        .filter(|s| s.is_final)
        .filter_map(|s| serde_json::to_string(s).ok())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The plain joined transcript text (used for word count, preview, summary).
pub fn joined_text(segments: &[TranscriptSegment]) -> String {
    segments
        .iter()
        .filter(|s| s.is_final)
        .map(|s| s.text.trim())
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// Upload the transcript JSONL to S3 under `transcripts/{id}.jsonl` and return
/// the storage key. Uses the same bucket/client as the rest of the vault.
pub async fn upload_transcript(
    pool: &DbPool,
    id: Uuid,
    jsonl: &str,
) -> Result<String, String> {
    let (client, bucket) = crate::apps::storage::handlers::s3_client(pool).await?;
    let key = format!("transcripts/{id}.jsonl");
    client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(ByteStream::from(jsonl.as_bytes().to_vec()))
        .content_type("application/x-ndjson")
        .send()
        .await
        .map_err(|e| format!("transcript upload failed: {e}"))?;
    Ok(key)
}

/// Persist the finished transcript: upload JSONL to S3, then write the index
/// fields (`transcript_storage_key`, `word_count`, `preview`, `duration_secs`)
/// to the DB row and mark it `ready` — transcript saved, awaiting the user's
/// post-stop choice (summarise / append / keep). Returns the joined text.
pub async fn flush(
    pool: &DbPool,
    id: Uuid,
    segments: &[TranscriptSegment],
    duration_secs: i32,
) -> Result<String, String> {
    let text = joined_text(segments);
    let word_count = text.split_whitespace().count() as i32;
    let preview: String = text.chars().take(200).collect();
    let jsonl = to_jsonl(segments);

    let key = upload_transcript(pool, id, &jsonl).await?;

    sqlx::query(
        "UPDATE db_recording_sessions \
         SET transcript_storage_key = $2, word_count = $3, preview = $4, \
             duration_secs = $5, status = 'ready', updated_at = NOW() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(&key)
    .bind(word_count)
    .bind(&preview)
    .bind(duration_secs)
    .execute(pool)
    .await
    .map_err(|e| format!("session update failed: {e}"))?;

    Ok(text)
}

/// Fetch + parse a session's JSONL transcript from S3 into segments. Used by the
/// transcript endpoint, the deferred summariser, and the append merge.
pub async fn read_segments(
    pool: &DbPool,
    key: &str,
) -> Result<Vec<TranscriptSegment>, String> {
    let (client, bucket) = crate::apps::storage::handlers::s3_client(pool).await?;
    let out = client
        .get_object()
        .bucket(&bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("transcript fetch failed: {e}"))?;
    let agg = out
        .body
        .collect()
        .await
        .map_err(|e| format!("transcript read failed: {e}"))?;
    let bytes = agg.into_bytes();
    let jsonl = String::from_utf8_lossy(&bytes);
    Ok(jsonl
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect())
}

/// Mark a session failed with an error message (best-effort).
pub async fn mark_failed(pool: &DbPool, id: Uuid, error: &str) {
    let _ = sqlx::query(
        "UPDATE db_recording_sessions SET status = 'failed', error = $2, updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(error)
    .execute(pool)
    .await;
}

/// Most transcript text handed to a recording's chat per turn; longer
/// transcripts keep their most recent part.
const CHAT_TRANSCRIPT_MAX_CHARS: usize = 120_000;

/// The transcript as speaker-labelled lines ("S1: …"), consecutive segments of
/// the same speaker merged. Unlabelled segments are plain lines.
fn speaker_text(segments: &[TranscriptSegment]) -> String {
    let mut lines: Vec<(Option<String>, String)> = Vec::new();
    for s in segments.iter().filter(|s| s.is_final) {
        let text = s.text.trim();
        if text.is_empty() {
            continue;
        }
        match lines.last_mut() {
            Some((speaker, line)) if *speaker == s.speaker => {
                line.push(' ');
                line.push_str(text);
            }
            _ => lines.push((s.speaker.clone(), text.to_string())),
        }
    }
    lines
        .into_iter()
        .map(|(speaker, line)| match speaker {
            Some(sp) => format!("{sp}: {line}"),
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// System-prompt block for a chat attached to recording `id`: its transcript,
/// live from the relay buffer while still recording, else the saved one.
/// `None` when the recording doesn't exist or isn't `user_id`'s.
pub async fn chat_context(
    pool: &DbPool,
    registry: &SessionRegistry,
    id: Uuid,
    user_id: &str,
) -> Option<String> {
    let (title, key): (String, Option<String>) = sqlx::query_as(
        "SELECT title, transcript_storage_key FROM db_recording_sessions \
         WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()?;

    let (segments, live) = match registry.get(&id) {
        Some(handle) => (handle.buffer.lock().await.segments.clone(), true),
        None => match key {
            Some(k) => (read_segments(pool, &k).await.unwrap_or_default(), false),
            None => (Vec::new(), false),
        },
    };
    let mut text = speaker_text(&segments);
    let total = text.chars().count();
    let cut = total > CHAT_TRANSCRIPT_MAX_CHARS;
    if cut {
        text = text.chars().skip(total - CHAT_TRANSCRIPT_MAX_CHARS).collect();
    }

    let state = if live {
        "still being recorded right now — the transcript below is everything said so far, \
         and it grows between the user's messages"
    } else {
        "finished"
    };
    let note = if cut {
        "\n(The transcript is long: only its most recent part is shown.)"
    } else {
        ""
    };
    let body = if text.is_empty() {
        "(nothing transcribed yet)".to_string()
    } else {
        text
    };
    Some(format!(
        "# The recording this chat is about\n\n\
         This chat is attached to the recording \"{title}\" (id {id}), {state}. The user is \
         asking you about it: answer from the transcript — summarise, quote, pull out \
         decisions, action items, names and numbers, or help them prepare what to say next. \
         Speaker labels (S1, S2…) are automatic and may be approximate. You don't need \
         list_recordings / get_recording for this one; the transcript is here.{note}\n\n\
         <transcript>\n{body}\n</transcript>"
    ))
}

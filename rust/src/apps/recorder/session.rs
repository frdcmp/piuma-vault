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
/// fields (`transcript_storage_key`, `word_count`, `preview`) to the DB row and
/// mark it `summarising`. Returns the joined transcript text for the summariser.
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
             duration_secs = $5, status = 'summarising', updated_at = NOW() \
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

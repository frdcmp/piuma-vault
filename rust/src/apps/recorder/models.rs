//! Recorder data models. `RecordingSession` is the DB index row; the full
//! transcript lives in S3 (see `session::flush`). DTOs cover the REST surface.

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// One recording session — the queryable index row in `db_recording_sessions`.
#[derive(Debug, Clone, Serialize, FromRow)]
pub struct RecordingSession {
    pub id: Uuid,
    pub user_id: String,
    pub title: String,
    pub status: String,
    pub provider: String,
    pub duration_secs: i32,
    pub transcript_storage_key: Option<String>,
    pub word_count: i32,
    pub preview: String,
    pub running_summary: Option<String>,
    pub final_note_id: Option<Uuid>,
    pub error: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Response to `POST /recorder/sessions`: the new session plus everything the
/// browser needs to open the streaming socket and shape its audio.
#[derive(Debug, Serialize)]
pub struct CreateSessionResponse {
    pub id: Uuid,
    /// Relative WS path (the client appends `?token=<jwt>`).
    pub ws_path: String,
    pub encoding: String,
    pub sample_rate: u32,
}

/// Optional title supplied when creating or stopping a session.
#[derive(Debug, Default, Deserialize)]
pub struct CreateSessionRequest {
    #[serde(default)]
    pub title: Option<String>,
}

/// `POST /recorder/sessions/{id}/title` body.
#[derive(Debug, Deserialize)]
pub struct TitleRequest {
    pub title: String,
}

/// `POST /recorder/sessions/{id}/append` body — merge session `{id}`'s transcript
/// into `target_id`, then re-summarise the target.
#[derive(Debug, Deserialize)]
pub struct AppendRequest {
    pub target_id: Uuid,
}

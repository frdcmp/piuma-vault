use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ── DB Model ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Note {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub title: String,
    pub content: String,
    #[sqlx(default)]
    pub tags: Vec<String>,
    #[sqlx(default)]
    pub folder: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Request DTOs ──

#[derive(Debug, Deserialize)]
pub struct CreateNoteRequest {
    pub title: String,
    pub content: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_folder")]
    pub folder: String,
}

fn default_folder() -> String {
    "/".to_string()
}

#[derive(Debug, Deserialize)]
pub struct UpdateNoteRequest {
    pub title: Option<String>,
    pub content: Option<String>,
    pub tags: Option<Vec<String>>,
    pub folder: Option<String>,
}

// Folders are ephemeral — they only exist as the `folder` path on notes. So
// "renaming" a folder is a bulk rewrite of that path prefix across every note
// under it (and its subfolders).
#[derive(Debug, Deserialize)]
pub struct RenameFolderRequest {
    pub from: String,
    pub to: String,
}

#[derive(Debug, Deserialize)]
pub struct ListNotesQuery {
    pub search: Option<String>,
    pub folder: Option<String>,
    pub tag: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

// ── Response DTOs ──

#[derive(Debug, Serialize)]
pub struct NoteListResponse {
    pub data: Vec<NoteListItem>,
    pub total: i64,
    pub limit: i64,
    pub offset: i64,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct NoteListItem {
    pub id: uuid::Uuid,
    pub title: String,
    #[sqlx(default)]
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub headline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    #[sqlx(default)]
    pub score: Option<f64>,
}

impl From<Note> for NoteListItem {
    fn from(n: Note) -> Self {
        NoteListItem {
            id: n.id,
            title: n.title,
            tags: n.tags,
            folder: n.folder,
            created_at: n.created_at,
            updated_at: n.updated_at,
            headline: None,
            score: None,
        }
    }
}

#[derive(Debug, Serialize)]
pub struct NotesApiError {
    pub error: String,
}

// ── Browse DTOs ──

#[derive(Debug, Deserialize)]
pub struct BrowseQuery {
    pub path: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct BrowseResponse {
    pub path: String,
    pub files: Vec<NoteListItem>,
    pub subfolders: Vec<String>,
}

// ── Folder Search DTOs ──

#[derive(Debug, Deserialize)]
pub struct FolderSearchQuery {
    pub q: Option<String>,
    pub limit: Option<i64>,
}

#[derive(Debug, Serialize)]
pub struct FolderMatch {
    pub path: String,
    pub leaf: String,
    pub file_count: i64,
}

// ── Embedding Job ──

#[derive(Debug, sqlx::FromRow)]
pub struct EmbeddingJob {
    pub id: uuid::Uuid,
    pub note_id: uuid::Uuid,
    pub content: String,
    pub created_at: Option<DateTime<Utc>>,
    pub started_at: Option<DateTime<Utc>>,
    pub attempts: i32,
}

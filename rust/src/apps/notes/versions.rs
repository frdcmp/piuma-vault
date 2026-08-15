//! Note version history. Snapshots are written by the `trg_notes_version`
//! DB trigger (see db_init.rs) — every UPDATE that changes title/content/tags/
//! folder stores the pre-image in `note_versions`, whichever module issued it.
//! This file exposes that history: list, fetch one, and restore. A restore is
//! itself a normal UPDATE, so the trigger snapshots the current state first —
//! restoring is always undoable.

use actix_web::{web, HttpResponse, Responder};
use chrono::{DateTime, Utc};
use serde::Serialize;
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::events::{NoteAction, NotesEventBus};
use super::models::{Note, NotesApiError};

/// Stamp the transaction-local `app.change_source` GUC so the versioning
/// trigger can attribute the change ('user', 'agent', 'share', 'recorder',
/// 'restore'). Transaction-local by design: pooled connections are reused, so
/// a session-level setting would leak across unrelated requests.
pub async fn set_change_source(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    source: &str,
) -> Result<(), sqlx::Error> {
    sqlx::query("SELECT set_config('app.change_source', $1, true)")
        .bind(source)
        .execute(&mut **tx)
        .await
        .map(|_| ())
}

fn err(msg: impl Into<String>) -> NotesApiError {
    NotesApiError { error: msg.into() }
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct NoteVersionListItem {
    pub id: i64,
    pub note_id: Uuid,
    pub title: String,
    #[sqlx(default)]
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub source: Option<String>,
    pub created_at: DateTime<Utc>,
    pub content_chars: i32,
}

#[derive(Debug, Serialize, sqlx::FromRow)]
pub struct NoteVersion {
    pub id: i64,
    pub note_id: Uuid,
    pub title: String,
    pub content: String,
    #[sqlx(default)]
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub source: Option<String>,
    pub created_at: DateTime<Utc>,
}

// ── LIST VERSIONS ──────────────────────────────────────────────────────────
//
// GET /admin/notes/{id}/versions — newest first, bodies omitted (only their
// length, so the UI can show size without shipping every snapshot).

pub async fn list_note_versions(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "notes.read") {
        return HttpResponse::Forbidden().json(err("Access denied: notes.read permission required"));
    }
    let note_id = path.into_inner();

    let rows: Result<Vec<NoteVersionListItem>, _> = sqlx::query_as(
        "SELECT id, note_id, title, tags, folder, source, created_at, \
                length(content)::INT AS content_chars \
         FROM note_versions \
         WHERE note_id = $1 AND user_id = $2 \
         ORDER BY created_at DESC, id DESC LIMIT 200",
    )
    .bind(note_id)
    .bind(&user.user_id)
    .fetch_all(pool.get_ref())
    .await;

    match rows {
        Ok(versions) => HttpResponse::Ok().json(serde_json::json!({ "data": versions })),
        Err(e) => {
            log::error!("note versions list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to list versions"))
        }
    }
}

// ── GET ONE VERSION ────────────────────────────────────────────────────────

pub async fn get_note_version(
    user: AuthenticatedUser,
    path: web::Path<(Uuid, i64)>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "notes.read") {
        return HttpResponse::Forbidden().json(err("Access denied: notes.read permission required"));
    }
    let (note_id, version_id) = path.into_inner();

    let row: Result<Option<NoteVersion>, _> = sqlx::query_as(
        "SELECT id, note_id, title, content, tags, folder, source, created_at \
         FROM note_versions \
         WHERE id = $1 AND note_id = $2 AND user_id = $3",
    )
    .bind(version_id)
    .bind(note_id)
    .bind(&user.user_id)
    .fetch_optional(pool.get_ref())
    .await;

    match row {
        Ok(Some(v)) => HttpResponse::Ok().json(v),
        Ok(None) => HttpResponse::NotFound().json(err("Version not found")),
        Err(e) => {
            log::error!("note version fetch failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch version"))
        }
    }
}

// ── RESTORE A VERSION ──────────────────────────────────────────────────────
//
// POST /admin/notes/{id}/versions/{version_id}/restore — copies the snapshot
// back onto the live note. The versioning trigger fires on this UPDATE too, so
// the pre-restore state becomes the newest version.

pub async fn restore_note_version(
    user: AuthenticatedUser,
    path: web::Path<(Uuid, i64)>,
    pool: web::Data<DbPool>,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    if !check_permission(&user, "notes.write") {
        return HttpResponse::Forbidden().json(err("Access denied: notes.write permission required"));
    }
    let (note_id, version_id) = path.into_inner();

    let version: Option<NoteVersion> = match sqlx::query_as(
        "SELECT id, note_id, title, content, tags, folder, source, created_at \
         FROM note_versions \
         WHERE id = $1 AND note_id = $2 AND user_id = $3",
    )
    .bind(version_id)
    .bind(note_id)
    .bind(&user.user_id)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("note version lookup failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to fetch version"));
        }
    };

    let version = match version {
        Some(v) => v,
        None => return HttpResponse::NotFound().json(err("Version not found")),
    };

    let restored: Result<Option<Note>, sqlx::Error> = async {
        let mut tx = pool.get_ref().begin().await?;
        set_change_source(&mut tx, "restore").await?;
        let note: Option<Note> = sqlx::query_as(
            "UPDATE notes SET title = $1, content = $2, tags = $3, folder = $4 \
             WHERE id = $5 AND user_id = $6 AND deleted_at IS NULL \
             RETURNING id, user_id, title, content, tags, folder, created_at, updated_at",
        )
        .bind(&version.title)
        .bind(&version.content)
        .bind(&version.tags)
        .bind(&version.folder)
        .bind(note_id)
        .bind(&user.user_id)
        .fetch_optional(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(note)
    }
    .await;

    match restored {
        Ok(Some(note)) => {
            // Same post-update bookkeeping as the normal edit path: re-embed and
            // tell live clients the note changed.
            let pool_clone = pool.get_ref().clone();
            let content = note.content.clone();
            tokio::spawn(async move {
                let _ = sqlx::query("DELETE FROM embedding_jobs WHERE note_id = $1")
                    .bind(note_id)
                    .execute(&pool_clone)
                    .await;
                if let Err(e) =
                    sqlx::query("INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)")
                        .bind(note_id)
                        .bind(content)
                        .execute(&pool_clone)
                        .await
                {
                    log::error!("Failed to enqueue embedding job for note {note_id}: {e}");
                }
            });
            bus.publish(NoteAction::Updated, note.id);
            HttpResponse::Ok().json(note)
        }
        Ok(None) => HttpResponse::NotFound().json(err("Note not found")),
        Err(e) => {
            log::error!("note version restore failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to restore version"))
        }
    }
}

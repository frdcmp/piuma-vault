//! REST surface for recording sessions. The streaming audio path is in `ws.rs`;
//! these endpoints create/list/inspect/stop/rename/delete the session rows.
//! Gated by `admin_access` (the recorder writes notes into the vault).

use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::notes::events::{NoteAction, NotesEventBus};
use crate::apps::settings::store;
use crate::db::db::DbPool;

use super::models::{CreateSessionRequest, CreateSessionResponse, RecordingSession, TitleRequest};
use super::session::SessionRegistry;

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": "admin_access required" }))
}

const FIELDS: &str = "id, user_id, title, status, provider, duration_secs, \
    transcript_storage_key, word_count, preview, running_summary, final_note_id, \
    error, created_at, updated_at";

/// POST /recorder/sessions — create a session row and return the WS path +
/// audio format the client must produce.
pub async fn create_session(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: Option<web::Json<CreateSessionRequest>>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let title = body
        .and_then(|b| b.into_inner().title)
        .unwrap_or_default();
    let provider = store::get(pool, store::TRANSCRIPTION_PROVIDER)
        .await
        .unwrap_or_else(|| "speechmatics".to_string());

    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO db_recording_sessions (user_id, title, provider) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&user.user_id)
    .bind(title.trim())
    .bind(&provider)
    .fetch_one(pool)
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::error!("create recording session: {e}");
            return HttpResponse::InternalServerError()
                .json(serde_json::json!({ "error": "could not create session" }));
        }
    };

    let fmt = crate::apps::transcription::audio_format(&provider);
    HttpResponse::Ok().json(CreateSessionResponse {
        id,
        ws_path: format!("/recorder/sessions/{id}/ws"),
        encoding: fmt.encoding,
        sample_rate: fmt.sample_rate,
    })
}

/// GET /recorder/sessions — list this user's sessions, newest first.
pub async fn list_sessions(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let rows: Vec<RecordingSession> = sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM db_recording_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT 200"
    ))
    .bind(&user.user_id)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    HttpResponse::Ok().json(rows)
}

/// GET /recorder/sessions/{id} — one session row.
pub async fn get_session(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    match fetch(pool.get_ref(), path.into_inner(), &user.user_id).await {
        Some(s) => HttpResponse::Ok().json(s),
        None => HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" })),
    }
}

/// GET /recorder/sessions/{id}/transcript — fetch the JSONL transcript from S3
/// and return its normalized segments + joined plain text. Empty until the
/// session has been flushed.
pub async fn get_transcript(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let pool = pool.get_ref();
    let Some(session) = fetch(pool, path.into_inner(), &user.user_id).await else {
        return HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" }));
    };
    let Some(key) = session.transcript_storage_key.as_deref() else {
        return HttpResponse::Ok()
            .json(serde_json::json!({ "segments": [], "text": "", "ready": false }));
    };

    let (client, bucket) = match crate::apps::storage::handlers::s3_client(pool).await {
        Ok(c) => c,
        Err(e) => return HttpResponse::BadGateway().json(serde_json::json!({ "error": e })),
    };
    let bytes = match client.get_object().bucket(&bucket).key(key).send().await {
        Ok(out) => match out.body.collect().await {
            Ok(agg) => agg.into_bytes(),
            Err(e) => {
                return HttpResponse::BadGateway()
                    .json(serde_json::json!({ "error": format!("transcript read failed: {e}") }))
            }
        },
        Err(e) => {
            return HttpResponse::BadGateway()
                .json(serde_json::json!({ "error": format!("transcript fetch failed: {e}") }))
        }
    };

    let jsonl = String::from_utf8_lossy(&bytes);
    let segments: Vec<crate::apps::transcription::models::TranscriptSegment> = jsonl
        .lines()
        .filter_map(|line| serde_json::from_str(line).ok())
        .collect();
    let text = super::session::joined_text(&segments);
    HttpResponse::Ok().json(serde_json::json!({ "segments": segments, "text": text, "ready": true }))
}

/// POST /recorder/sessions/{id}/stop — ask the live relay to finish. The actual
/// flush + summary happens in the relay task; the client also gets a `done`
/// frame over the WS. Returns 202 if a live session was signalled.
pub async fn stop_session(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    registry: web::Data<SessionRegistry>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let id = path.into_inner();
    if fetch(pool.get_ref(), id, &user.user_id).await.is_none() {
        return HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" }));
    }
    match registry.get(&id) {
        Some(handle) => {
            handle.stop.notify_waiters();
            HttpResponse::Accepted().json(serde_json::json!({ "stopping": true }))
        }
        None => HttpResponse::Conflict()
            .json(serde_json::json!({ "error": "session is not currently recording" })),
    }
}

/// POST /recorder/sessions/{id}/title — rename a session.
pub async fn set_title(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<TitleRequest>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let id = path.into_inner();
    let res = sqlx::query(
        "UPDATE db_recording_sessions SET title = $3, updated_at = NOW() WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(&user.user_id)
    .bind(body.into_inner().title.trim())
    .execute(pool.get_ref())
    .await;
    match res {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::Ok().json(serde_json::json!({ "ok": true })),
        Ok(_) => HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" })),
        Err(e) => {
            log::error!("set title: {e}");
            HttpResponse::InternalServerError().json(serde_json::json!({ "error": "update failed" }))
        }
    }
}

/// DELETE /recorder/sessions/{id} — remove the session, its live state, and its
/// S3 transcript (best-effort). The summary note (if any) is soft-deleted to
/// Trash — same as deleting a note normally, so it's recoverable.
pub async fn delete_session(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    registry: web::Data<SessionRegistry>,
    notes_bus: web::Data<NotesEventBus>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let id = path.into_inner();
    let Some(session) = fetch(pool.get_ref(), id, &user.user_id).await else {
        return HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" }));
    };

    registry.remove(&id);

    // Best-effort S3 cleanup of the transcript log.
    if let Some(key) = session.transcript_storage_key.as_deref() {
        if let Ok((client, bucket)) = crate::apps::storage::handlers::s3_client(pool.get_ref()).await
        {
            let _ = client.delete_object().bucket(&bucket).key(key).send().await;
        }
    }

    // Soft-delete the linked summary note (stamp `deleted_at` → Trash), matching
    // the normal note-delete path so it stays recoverable. Best-effort.
    if let Some(note_id) = session.final_note_id {
        let res = sqlx::query(
            "UPDATE notes SET deleted_at = NOW() \
             WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
        )
        .bind(note_id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await;
        if matches!(res, Ok(r) if r.rows_affected() > 0) {
            notes_bus.publish(NoteAction::Deleted, note_id);
        }
    }

    let _ = sqlx::query("DELETE FROM db_recording_sessions WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await;
    HttpResponse::Ok().json(serde_json::json!({ "ok": true }))
}

async fn fetch(pool: &DbPool, id: Uuid, user_id: &str) -> Option<RecordingSession> {
    sqlx::query_as(&format!(
        "SELECT {FIELDS} FROM db_recording_sessions WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
}

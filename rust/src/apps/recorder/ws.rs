//! The streaming relay: browser ⇄ backend ⇄ transcription provider.
//!
//! The browser opens this socket with `?token=<jwt>` (the WebSocket API can't
//! set an Authorization header, so auth rides in the query). We authenticate,
//! open the upstream provider socket via the `transcription` adapter, then pump
//! PCM frames up and normalized transcript segments down. On stop (a `stop`
//! text frame, the socket closing, or `POST /stop`) we flush the transcript to
//! S3 and run the summariser, then send the client a `done` frame.
//!
//! The backend never buffers audio — each binary frame is forwarded immediately
//! and dropped. Only finalized transcript text is retained (in `LiveBuffer`).

use std::time::{Duration, Instant};

use actix_web::{web, HttpRequest, HttpResponse};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use tokio_tungstenite::tungstenite::Message as TMsg;
use uuid::Uuid;

use crate::apps::auth::middleware::Auth;
use crate::apps::transcription::{self, models::TranscriberConfig};
use crate::db::db::DbPool;

use super::session::{self, SessionRegistry};
use super::summarise;

#[derive(Deserialize)]
pub struct WsAuthQuery {
    token: String,
}

/// How long to wait for trailing transcripts after asking the provider to end.
const DRAIN_TIMEOUT: Duration = Duration::from_secs(6);

/// GET /recorder/sessions/{id}/ws — upgrade to the streaming relay.
pub async fn ws_handler(
    req: HttpRequest,
    body: web::Payload,
    path: web::Path<Uuid>,
    query: web::Query<WsAuthQuery>,
    pool: web::Data<DbPool>,
    registry: web::Data<SessionRegistry>,
) -> Result<HttpResponse, actix_web::Error> {
    let id = path.into_inner();

    // Auth via query token (browsers can't set WS headers). Require admin_access.
    let claims = Auth::validate_token(&query.token)?;
    if !claims.permissions.iter().any(|p| p == "admin_access") {
        return Ok(HttpResponse::Forbidden().finish());
    }
    let user_id = claims.sub.clone();

    // The session row must exist, belong to this user, and still be recording.
    let row: Option<(String, String)> = sqlx::query_as(
        "SELECT title, status FROM db_recording_sessions WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(&user_id)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(actix_web::error::ErrorInternalServerError)?;
    let Some((title, status)) = row else {
        return Ok(HttpResponse::NotFound().finish());
    };
    if status != "recording" {
        return Ok(HttpResponse::Conflict().finish());
    }

    // Resolve the active provider + key, then open the upstream socket.
    let cfg = match transcription::config_for(pool.get_ref()).await {
        Ok(c) => c,
        Err(e) => return Ok(HttpResponse::BadRequest().body(e)),
    };
    let upstream = match transcription::connect(&cfg.provider, &cfg).await {
        Ok(ws) => ws,
        Err(e) => {
            session::mark_failed(pool.get_ref(), id, &e).await;
            return Ok(HttpResponse::BadGateway().body(e));
        }
    };

    // Upgrade the browser side and run the relay in a detached task.
    let (response, ws_session, ws_stream) = actix_ws::handle(&req, body)?;
    let handle = registry.register(id);
    let pool = pool.get_ref().clone();
    let registry = registry.get_ref().clone();

    actix_web::rt::spawn(relay(
        id, user_id, title, cfg, upstream, ws_session, ws_stream, handle, pool, registry,
    ));

    Ok(response)
}

#[allow(clippy::too_many_arguments)]
async fn relay(
    id: Uuid,
    user_id: String,
    title: String,
    cfg: TranscriberConfig,
    upstream: transcription::UpstreamWs,
    mut client: actix_ws::Session,
    mut client_rx: actix_ws::MessageStream,
    handle: session::LiveHandle,
    pool: DbPool,
    registry: SessionRegistry,
) {
    let started = Instant::now();
    let (mut up_tx, mut up_rx) = upstream.split();
    let buffer = handle.buffer.clone();
    let stop = handle.stop.clone();

    // Main pump: forward audio up, transcripts down, until a stop signal.
    loop {
        tokio::select! {
            // Browser → backend.
            msg = client_rx.next() => match msg {
                Some(Ok(actix_ws::Message::Binary(bytes))) => {
                    {
                        let mut buf = buffer.lock().await;
                        buf.audio_seq += 1;
                    }
                    if up_tx.send(TMsg::Binary(bytes.to_vec())).await.is_err() {
                        break;
                    }
                }
                Some(Ok(actix_ws::Message::Text(t))) => {
                    // The only control message we accept is a stop request.
                    if t.trim().contains("stop") {
                        break;
                    }
                }
                Some(Ok(actix_ws::Message::Ping(p))) => { let _ = client.pong(&p).await; }
                Some(Ok(actix_ws::Message::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
            // Provider → backend.
            msg = up_rx.next() => match msg {
                Some(Ok(TMsg::Text(raw))) => {
                    if let Some(segments) = transcription::parse(&cfg.provider, &raw) {
                        let mut buf = buffer.lock().await;
                        for seg in segments {
                            // Stream every segment down for the live UI; keep
                            // only finals for the durable transcript.
                            let _ = client.text(
                                serde_json::json!({ "type": "transcript", "segment": seg }).to_string(),
                            ).await;
                            if seg.is_final {
                                buf.segments.push(seg);
                            }
                        }
                    }
                }
                Some(Ok(TMsg::Close(_))) | None => break,
                Some(Ok(_)) => {}
                Some(Err(_)) => break,
            },
            // Out-of-band stop (POST /recorder/sessions/{id}/stop).
            _ = stop.notified() => break,
        }
    }

    // Ask the provider to flush, then drain trailing finals briefly.
    let seq = buffer.lock().await.audio_seq;
    let _ = up_tx.send(TMsg::Text(transcription::end_message(&cfg.provider, seq))).await;
    loop {
        match tokio::time::timeout(DRAIN_TIMEOUT, up_rx.next()).await {
            Ok(Some(Ok(TMsg::Text(raw)))) => {
                if let Some(segments) = transcription::parse(&cfg.provider, &raw) {
                    let mut buf = buffer.lock().await;
                    for seg in segments {
                        if seg.is_final {
                            buf.segments.push(seg);
                        }
                    }
                }
            }
            Ok(Some(Ok(TMsg::Close(_)))) | Ok(None) | Err(_) => break,
            Ok(Some(Ok(_))) => {}
            Ok(Some(Err(_))) => break,
        }
    }
    let _ = up_tx.close().await;

    let duration = started.elapsed().as_secs() as i32;
    let segments = std::mem::take(&mut buffer.lock().await.segments);
    registry.remove(&id);

    let _ = client
        .text(serde_json::json!({ "type": "summarising" }).to_string())
        .await;

    // Flush transcript → S3, then summarise → note.
    let result: Result<Uuid, String> = async {
        let text = session::flush(&pool, id, &segments, duration).await?;
        summarise::run(&pool, id, &user_id, &title, &text).await
    }
    .await;

    match result {
        Ok(note_id) => {
            let _ = client
                .text(
                    serde_json::json!({ "type": "done", "session_id": id, "note_id": note_id })
                        .to_string(),
                )
                .await;
        }
        Err(e) => {
            session::mark_failed(&pool, id, &e).await;
            let _ = client
                .text(serde_json::json!({ "type": "error", "message": e }).to_string())
                .await;
        }
    }
    let _ = client.close(None).await;
}

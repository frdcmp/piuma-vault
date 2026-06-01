use crate::apps::auth::middleware::Auth;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use futures::stream::unfold;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{interval, Interval};
use uuid::Uuid;

const CHANNEL_CAPACITY: usize = 256;
const HEARTBEAT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum NoteAction {
    Created,
    Updated,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
pub struct NoteEvent {
    pub action: NoteAction,
    pub id: Uuid,
}

#[derive(Clone)]
pub struct NotesEventBus {
    tx: Arc<broadcast::Sender<NoteEvent>>,
}

impl NotesEventBus {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
        Self { tx: Arc::new(tx) }
    }

    pub fn publish(&self, action: NoteAction, id: Uuid) {
        let _ = self.tx.send(NoteEvent { action, id });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<NoteEvent> {
        self.tx.subscribe()
    }
}

#[derive(Debug, Deserialize)]
pub struct SseAuthQuery {
    token: Option<String>,
}

// Browser EventSource can't send an Authorization header, so this endpoint
// accepts the JWT via `?token=` query param. Native clients (mobile app) that
// can send headers should use `Authorization: Bearer <jwt>` instead — keeps
// the token out of URLs and access logs. The payload only carries {action, id}
// so no note content rides the stream regardless.
pub async fn notes_event_stream(
    req: HttpRequest,
    query: web::Query<SseAuthQuery>,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    let header_token = req
        .headers()
        .get("Authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| {
            let s = s.trim();
            if s.len() > 7 && s[..7].eq_ignore_ascii_case("Bearer ") {
                Some(s[7..].to_string())
            } else {
                None
            }
        });

    let token = match header_token.or_else(|| query.token.clone()) {
        Some(t) => t,
        None => return HttpResponse::Unauthorized().finish(),
    };

    if Auth::validate_token(&token).is_err() {
        return HttpResponse::Unauthorized().finish();
    }

    struct State {
        rx: broadcast::Receiver<NoteEvent>,
        heartbeat: Interval,
    }

    let mut heartbeat = interval(Duration::from_secs(HEARTBEAT_SECS));
    heartbeat.tick().await; // consume immediate first tick

    let state = State {
        rx: bus.subscribe(),
        heartbeat,
    };

    let stream = unfold(state, |mut s| async move {
        let chunk = tokio::select! {
            ev = s.rx.recv() => match ev {
                Ok(event) => {
                    let payload = serde_json::to_string(&event).unwrap_or_else(|_| "{}".into());
                    web::Bytes::from(format!("event: note\ndata: {}\n\n", payload))
                }
                Err(RecvError::Lagged(_)) => web::Bytes::from_static(b": lagged\n\n"),
                Err(RecvError::Closed) => return None,
            },
            _ = s.heartbeat.tick() => web::Bytes::from_static(b": ping\n\n"),
        };
        Some((Ok::<_, actix_web::Error>(chunk), s))
    });

    HttpResponse::Ok()
        .content_type("text/event-stream")
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(stream)
}

//! Generic SSE event bus for live cross-device data sync.
//!
//! A `ResourceEventBus<R>` broadcasts lightweight `{action, id}` events for one
//! resource kind, and `event_stream::<R>` serves them as `text/event-stream`.
//! Handlers that mutate a resource call `bus.publish(...)`; connected clients
//! (web, mobile) re-fetch via the normal auth-protected routes. Only `{action,
//! id}` rides the wire — never resource content — so the stream is safe to fan
//! out to every logged-in device.
//!
//! This generalizes the original notes-only bus (`apps::notes::events`). New
//! resources just declare a zero-sized marker implementing [`Resource`].

use crate::apps::auth::middleware::Auth;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use futures::stream::unfold;
use serde::{Deserialize, Serialize};
use std::marker::PhantomData;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;
use tokio::sync::broadcast::error::RecvError;
use tokio::time::{interval, Interval};
use uuid::Uuid;

const CHANNEL_CAPACITY: usize = 256;
const HEARTBEAT_SECS: u64 = 20;

/// Marks a resource kind and names the SSE event it emits (`event: <EVENT>`).
pub trait Resource: 'static {
    const EVENT: &'static str;
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ResourceAction {
    Created,
    Updated,
    Deleted,
}

#[derive(Debug, Clone, Serialize)]
pub struct ResourceEvent {
    pub action: ResourceAction,
    pub id: Uuid,
}

/// A broadcast bus for one resource kind. Cheap to clone (shares one sender).
pub struct ResourceEventBus<R: Resource> {
    tx: Arc<broadcast::Sender<ResourceEvent>>,
    _marker: PhantomData<R>,
}

// Manual Clone so we don't force `R: Clone` (R is a zero-sized marker).
impl<R: Resource> Clone for ResourceEventBus<R> {
    fn clone(&self) -> Self {
        Self {
            tx: self.tx.clone(),
            _marker: PhantomData,
        }
    }
}

impl<R: Resource> Default for ResourceEventBus<R> {
    fn default() -> Self {
        Self::new()
    }
}

impl<R: Resource> ResourceEventBus<R> {
    pub fn new() -> Self {
        let (tx, _rx) = broadcast::channel(CHANNEL_CAPACITY);
        Self {
            tx: Arc::new(tx),
            _marker: PhantomData,
        }
    }

    /// Fire-and-forget: a send with no live subscribers is fine (returns Err,
    /// which we ignore) — the bus is purely a best-effort live hint.
    pub fn publish(&self, action: ResourceAction, id: Uuid) {
        let _ = self.tx.send(ResourceEvent { action, id });
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ResourceEvent> {
        self.tx.subscribe()
    }
}

#[derive(Debug, Deserialize)]
pub struct SseAuthQuery {
    token: Option<String>,
}

// Browser EventSource can't send an Authorization header, so this endpoint also
// accepts the JWT via `?token=`. Native clients (mobile) send `Authorization:
// Bearer <jwt>` instead, keeping tokens out of URLs and access logs.
fn extract_token(req: &HttpRequest, query: &SseAuthQuery) -> Option<String> {
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
    header_token.or_else(|| query.token.clone())
}

/// SSE endpoint for one resource kind. Validates the JWT, then streams
/// `event: <R::EVENT>` frames plus a `: ping` heartbeat.
pub async fn event_stream<R: Resource>(
    req: HttpRequest,
    query: web::Query<SseAuthQuery>,
    bus: web::Data<ResourceEventBus<R>>,
) -> impl Responder {
    let token = match extract_token(&req, &query) {
        Some(t) => t,
        None => return HttpResponse::Unauthorized().finish(),
    };
    if Auth::validate_token(&token).is_err() {
        return HttpResponse::Unauthorized().finish();
    }

    struct State {
        rx: broadcast::Receiver<ResourceEvent>,
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
                    web::Bytes::from(format!("event: {}\ndata: {}\n\n", R::EVENT, payload))
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

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
use crate::apps::auth::models::AuthenticatedUser;
use actix_web::dev::Payload;
use actix_web::{web, FromRequest, HttpRequest, HttpResponse, Responder};
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

// Browser EventSource can't send headers, so the JWT may also ride in `?token=`.
// Everything else goes through the normal `AuthenticatedUser` extractor: a Bearer
// JWT (mobile) or an `x-api-key` (desktop clients such as decashell), so a key
// scoped to a resource can follow its stream too. Only `{action, id}` is streamed,
// so any authenticated principal may listen.
async fn authorized(req: &HttpRequest, query: &SseAuthQuery) -> bool {
    if AuthenticatedUser::from_request(req, &mut Payload::None).await.is_ok() {
        return true;
    }
    query.token.as_deref().is_some_and(|t| Auth::validate_token(t).is_ok())
}

/// SSE endpoint for one resource kind. Authenticates the caller, then streams
/// `event: <R::EVENT>` frames plus a `: ping` heartbeat.
pub async fn event_stream<R: Resource>(
    req: HttpRequest,
    query: web::Query<SseAuthQuery>,
    bus: web::Data<ResourceEventBus<R>>,
) -> impl Responder {
    if !authorized(&req, &query).await {
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

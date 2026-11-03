//! Live updates for the Inbox: something changed in a conversation (a message, a card, its
//! switches), in the news, or Pigeon is typing to someone. Both the backend and the
//! pigeon-worker change things, so every change goes through Postgres (`NOTIFY pigeon_events`);
//! the backend listens and streams each user their own (`GET /admin/pigeon/events`, SSE). Only
//! `{kind, id}` rides the wire: the apps re-fetch through the normal routes.

use std::time::Duration;

use actix_web::dev::Payload;
use actix_web::{web, FromRequest, HttpRequest, HttpResponse, Responder};
use futures::stream::unfold;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use uuid::Uuid;

use crate::apps::auth::middleware::Auth;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

const CHANNEL: &str = "pigeon_events";

/// The kinds of event besides the ones the apps re-fetch on.
pub mod kinds {
    /// A message from someone came in (`id`: the item): the worker pushes it to the phone.
    pub const MESSAGE_IN: &str = "message_in";
}
const HEARTBEAT_SECS: u64 = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Event {
    pub user_id: String,
    /// conversation (its messages, cards or switches changed) · news · connections · message_in
    pub kind: String,
    pub id: Option<Uuid>,
}

/// Tell the user's open apps that something changed. Best effort.
pub async fn publish(pool: &DbPool, user_id: &str, kind: &str, id: Option<Uuid>) {
    let ev = Event { user_id: user_id.to_string(), kind: kind.to_string(), id };
    let payload = serde_json::to_string(&ev).unwrap_or_default();
    if let Err(e) = sqlx::query("SELECT pg_notify($1, $2)").bind(CHANNEL).bind(payload).execute(pool).await {
        log::debug!("pigeon events: {e}");
    }
}

/// A conversation changed: its chat, and the list it's in.
pub async fn conversation(pool: &DbPool, conversation: Uuid) {
    let user: Option<String> = sqlx::query_scalar("SELECT user_id FROM db_pigeon_conversations WHERE id = $1")
        .bind(conversation)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten();
    if let Some(u) = user {
        publish(pool, &u, "conversation", Some(conversation)).await;
    }
}

/// The backend's side: Postgres' notifications onto a broadcast every SSE stream reads.
#[derive(Clone)]
pub struct Bus {
    tx: broadcast::Sender<Event>,
}

impl Bus {
    /// Listens for as long as the backend runs (reconnecting when the connection drops).
    pub fn start(pool: DbPool) -> Bus {
        let (tx, _) = broadcast::channel(256);
        let bus = Bus { tx: tx.clone() };
        tokio::spawn(async move {
            loop {
                match sqlx::postgres::PgListener::connect_with(&pool).await {
                    Ok(mut l) => {
                        if let Err(e) = l.listen(CHANNEL).await {
                            log::warn!("pigeon events: listen: {e}");
                        } else {
                            while let Ok(n) = l.recv().await {
                                if let Ok(ev) = serde_json::from_str::<Event>(n.payload()) {
                                    let _ = tx.send(ev);
                                }
                            }
                        }
                    }
                    Err(e) => log::warn!("pigeon events: connect: {e}"),
                }
                tokio::time::sleep(Duration::from_secs(3)).await;
            }
        });
        bus
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }
}

#[derive(Debug, Deserialize)]
pub struct SseAuth {
    token: Option<String>,
}

/// `GET /admin/pigeon/events`: this user's events, as `event: pigeon` frames, with a heartbeat.
/// A browser's EventSource can't send headers, so the JWT may ride in `?token=`.
pub async fn stream(req: HttpRequest, query: web::Query<SseAuth>, bus: web::Data<Bus>) -> impl Responder {
    let user = match AuthenticatedUser::from_request(&req, &mut Payload::None).await {
        Ok(u) => Some(u.user_id),
        Err(_) => query.token.as_deref().and_then(|t| Auth::validate_token(t).ok()).map(|c| c.sub),
    };
    let Some(user) = user else { return HttpResponse::Unauthorized().finish() };
    let rx = bus.tx.subscribe();
    let tick = tokio::time::interval(Duration::from_secs(HEARTBEAT_SECS));
    let body = unfold((rx, tick, user), |(mut rx, mut tick, user)| async move {
        loop {
            tokio::select! {
                ev = rx.recv() => match ev {
                    Ok(ev) if ev.user_id == user => {
                        let data = serde_json::json!({ "kind": ev.kind, "id": ev.id });
                        let frame = format!("event: pigeon\ndata: {data}\n\n");
                        return Some((Ok::<_, actix_web::Error>(web::Bytes::from(frame)), (rx, tick, user)));
                    }
                    Ok(_) => continue,
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        // missed some: tell the app to re-fetch everything
                        let frame = "event: pigeon\ndata: {\"kind\":\"resync\",\"id\":null}\n\n".to_string();
                        return Some((Ok(web::Bytes::from(frame)), (rx, tick, user)));
                    }
                    Err(broadcast::error::RecvError::Closed) => return None,
                },
                _ = tick.tick() => return Some((Ok(web::Bytes::from_static(b": ping\n\n")), (rx, tick, user))),
            }
        }
    });
    HttpResponse::Ok()
        .insert_header(("Content-Type", "text/event-stream"))
        .insert_header(("Cache-Control", "no-cache"))
        .insert_header(("X-Accel-Buffering", "no"))
        .streaming(body)
}

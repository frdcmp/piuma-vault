//! Client-side error ingest.
//!
//! The browser has no telemetry of its own: a TypeError in the composer or a
//! failed render on a public share page dies in the console where nobody sees
//! it. This endpoint is the bridge — the frontend POSTs batches of client
//! errors here and they join the same fire-and-forget pipeline as backend
//! events, tagged `source = "frontend"`.
//!
//! Deliberately **unauthenticated**: the pages most likely to break in a way we
//! never hear about are the public ones (`/share/v/{slug}`, the login screen),
//! and those have no token to send. That makes it an open write path, so it is
//! rate-limited per IP and every field is length-capped before it is enqueued.
//! When a caller *does* carry credentials we attach the user, so errors from a
//! signed-in session are attributable.

use actix_web::{web, HttpRequest, HttpResponse, Responder};
use serde::Deserialize;
use std::time::Duration;

use super::{Event, Severity};
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::auth::rate_limit::{client_ip, RateLimiter};

/// Per-IP budget. A browser that reports more than this is looping (a render
/// error firing every frame); shedding is the right answer, not ingesting it.
const MAX_REPORTS: u32 = 60;
const WINDOW: Duration = Duration::from_secs(60);

/// Events accepted in a single POST.
const MAX_BATCH: usize = 20;

// Field caps. A stack trace is the whole point of the payload, so `message` is
// generous; the rest are identifiers and stay short.
const MAX_MESSAGE: usize = 4_000;
const MAX_ATTRS: usize = 4_000;
const MAX_SHORT: usize = 200;

#[derive(Debug, Deserialize)]
pub struct ClientEvent {
    /// Free-form grouping, e.g. "attachment", "render", "window".
    #[serde(default)]
    pub category: String,
    /// What happened, e.g. "error", "unhandledrejection".
    #[serde(default)]
    pub event_type: String,
    /// "warn" or "error"; anything else is clamped to "error".
    #[serde(default)]
    pub severity: String,
    /// Error message, ideally with a stack.
    #[serde(default)]
    pub message: String,
    /// The route the user was on when it broke.
    #[serde(default)]
    pub route: String,
    #[serde(default)]
    pub error_code: String,
    /// Anything else worth keeping (file name, mime, component).
    #[serde(default)]
    pub attributes: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ClientBatch {
    pub events: Vec<ClientEvent>,
}

fn cap(s: String, max: usize) -> String {
    if s.len() <= max {
        return s;
    }
    // Truncate on a char boundary — a multi-byte char split mid-way would make
    // the string invalid for the JSON encoder downstream.
    let mut end = max;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

/// POST /telemetry/client
pub async fn ingest(
    req: HttpRequest,
    body: web::Json<ClientBatch>,
    limiter: web::Data<RateLimiter>,
    user: Option<AuthenticatedUser>,
) -> impl Responder {
    let ip = client_ip(&req);
    if let Err(retry_after) = limiter
        .check("telemetry_client", &ip, MAX_REPORTS, WINDOW)
        .await
    {
        return HttpResponse::TooManyRequests()
            .insert_header(("Retry-After", retry_after.to_string()))
            .finish();
    }

    let user_agent = req
        .headers()
        .get("user-agent")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    for ev in body.into_inner().events.into_iter().take(MAX_BATCH) {
        let severity = match ev.severity.as_str() {
            "warn" => Severity::Warn,
            _ => Severity::Error,
        };
        let category = if ev.category.is_empty() {
            "client".to_string()
        } else {
            cap(ev.category, MAX_SHORT)
        };
        let event_type = if ev.event_type.is_empty() {
            "error".to_string()
        } else {
            cap(ev.event_type, MAX_SHORT)
        };

        let mut event = Event::new(&category, &event_type, severity)
            .source("frontend")
            .msg(cap(ev.message, MAX_MESSAGE))
            .route(cap(ev.route, MAX_SHORT))
            .error_code(cap(ev.error_code, MAX_SHORT))
            .ip(&ip)
            .user_agent(&user_agent);
        if let Some(attrs) = ev.attributes {
            event.attributes = cap(attrs.to_string(), MAX_ATTRS);
        }
        if let Some(u) = &user {
            event = event.user(u);
        }
        event.emit();
    }

    HttpResponse::NoContent().finish()
}

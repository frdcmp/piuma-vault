//! Lightweight, fire-and-forget telemetry → the shared `ingest-api` gateway.
//!
//! `Event::new(...).emit()` is non-blocking: the event is dropped onto a bounded
//! in-process channel and a background task batches events and POSTs them to
//! `TELEMETRY_INGEST_URL` with `TELEMETRY_API_KEY` as a bearer token. The app
//! holds only a URL + key — no ClickHouse/Valkey client, no credentials.
//!
//! When `TELEMETRY_INGEST_URL` is unset, telemetry is **disabled**: `init()`
//! spawns nothing and `emit()` is a no-op. This keeps the public repo runnable
//! with zero extra infrastructure.

#![allow(dead_code)]

pub mod logging;

use std::sync::OnceLock;
use std::time::Duration;

use actix_web::dev::ServiceRequest;
use serde::Serialize;
use tokio::sync::mpsc;

use crate::apps::auth::models::AuthenticatedUser;

/// Bounded queue between request handlers and the flush task. `try_send` drops
/// events when full, so a telemetry stall can never back-pressure a request.
const QUEUE_CAPACITY: usize = 10_000;
/// Flush when this many events are buffered…
const BATCH_MAX: usize = 500;
/// …or at least this often, whichever comes first.
const FLUSH_INTERVAL: Duration = Duration::from_millis(1000);

static SENDER: OnceLock<mpsc::Sender<Event>> = OnceLock::new();

#[derive(Debug, Clone, Copy)]
pub enum Severity {
    Debug,
    Info,
    Warn,
    Error,
}
impl Severity {
    fn as_str(self) -> &'static str {
        match self {
            Severity::Debug => "debug",
            Severity::Info => "info",
            Severity::Warn => "warn",
            Severity::Error => "error",
        }
    }
}

/// One telemetry event. Field names match the ClickHouse `events` columns;
/// empty/zero fields fall back to column defaults on insert, so only set what's
/// relevant.
#[derive(Debug, Clone, Default, Serialize)]
pub struct Event {
    pub ts: String,
    pub source: String,
    pub category: String,
    pub event_type: String,
    pub severity: String,
    pub user_id: String,
    pub user_email: String,
    pub session_id: String,
    pub request_id: String,
    pub entity_type: String,
    pub entity_id: String,
    pub message: String,
    pub error_code: String,
    pub model: String,
    pub tokens_input: u32,
    pub tokens_output: u32,
    pub duration_ms: u32,
    pub http_status: u16,
    pub route: String,
    pub app_version: String,
    pub server: String,
    pub ip: String,
    pub user_agent: String,
    /// Free-form JSON, stored as a string (queryable via `JSONExtract`).
    pub attributes: String,
}

impl Event {
    pub fn new(category: &str, event_type: &str, severity: Severity) -> Self {
        Event {
            // ClickHouse DateTime64 input (space sep, no 'T'/'Z'); the gateway
            // also enables best-effort parsing, but this is the canonical form.
            ts: chrono::Utc::now().format("%Y-%m-%d %H:%M:%S%.3f").to_string(),
            source: "backend".to_string(),
            category: category.to_string(),
            event_type: event_type.to_string(),
            severity: severity.as_str().to_string(),
            app_version: std::env::var("APP_VERSION").unwrap_or_default(),
            server: std::env::var("SERVER_NAME")
                .map(|s| s.trim_matches('"').to_string())
                .unwrap_or_default(),
            ..Default::default()
        }
    }

    // ── ergonomic builders (chainable) ────────────────────────────────────────
    pub fn user(mut self, u: &AuthenticatedUser) -> Self {
        self.user_id = u.user_id.clone();
        self.user_email = u.email.clone();
        self
    }
    pub fn user_email(mut self, email: impl ToString) -> Self {
        self.user_email = email.to_string();
        self
    }
    pub fn user_id(mut self, id: impl ToString) -> Self {
        self.user_id = id.to_string();
        self
    }
    pub fn entity(mut self, entity_type: &str, entity_id: impl ToString) -> Self {
        self.entity_type = entity_type.to_string();
        self.entity_id = entity_id.to_string();
        self
    }
    pub fn msg(mut self, m: impl ToString) -> Self {
        self.message = m.to_string();
        self
    }
    pub fn error_code(mut self, c: impl ToString) -> Self {
        self.error_code = c.to_string();
        self
    }
    pub fn model(mut self, m: impl ToString) -> Self {
        self.model = m.to_string();
        self
    }
    pub fn tokens(mut self, input: u32, output: u32) -> Self {
        self.tokens_input = input;
        self.tokens_output = output;
        self
    }
    pub fn status(mut self, s: u16) -> Self {
        self.http_status = s;
        self
    }
    pub fn duration(mut self, ms: u32) -> Self {
        self.duration_ms = ms;
        self
    }
    pub fn route(mut self, r: impl ToString) -> Self {
        self.route = r.to_string();
        self
    }
    pub fn ip(mut self, ip: impl ToString) -> Self {
        self.ip = ip.to_string();
        self
    }
    pub fn user_agent(mut self, ua: impl ToString) -> Self {
        self.user_agent = ua.to_string();
        self
    }
    /// Attach free-form JSON attributes (stored as a string).
    pub fn attrs(mut self, v: serde_json::Value) -> Self {
        self.attributes = v.to_string();
        self
    }

    /// Fire-and-forget: drop onto the queue. Never blocks, never errors.
    pub fn emit(self) {
        emit(self);
    }
}

/// Fire-and-forget enqueue. No-op when telemetry is disabled or the queue is
/// full (the latter sheds load rather than blocking the request path).
pub fn emit(event: Event) {
    if let Some(tx) = SENDER.get() {
        let _ = tx.try_send(event);
    }
}

/// Start the background flush task. Call once at startup. Reads
/// `TELEMETRY_INGEST_URL` (required to enable) and `TELEMETRY_API_KEY`.
pub fn init() {
    let url = std::env::var("TELEMETRY_INGEST_URL").unwrap_or_default();
    if url.is_empty() {
        log::info!("telemetry disabled (TELEMETRY_INGEST_URL unset)");
        return;
    }
    let api_key = std::env::var("TELEMETRY_API_KEY").unwrap_or_default();
    if api_key.is_empty() {
        log::warn!("TELEMETRY_INGEST_URL set but TELEMETRY_API_KEY empty — telemetry disabled");
        return;
    }

    let (tx, rx) = mpsc::channel::<Event>(QUEUE_CAPACITY);
    if SENDER.set(tx).is_err() {
        log::warn!("telemetry already initialized");
        return;
    }
    tokio::spawn(flush_loop(rx, url.clone(), api_key));
    log::info!("📤 telemetry enabled → {url}");
}

async fn flush_loop(mut rx: mpsc::Receiver<Event>, url: String, api_key: String) {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap_or_default();
    let mut batch: Vec<Event> = Vec::with_capacity(BATCH_MAX);
    let mut ticker = tokio::time::interval(FLUSH_INTERVAL);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        tokio::select! {
            maybe = rx.recv() => {
                match maybe {
                    Some(ev) => {
                        batch.push(ev);
                        if batch.len() >= BATCH_MAX {
                            send_batch(&client, &url, &api_key, &mut batch).await;
                        }
                    }
                    None => {
                        // Channel closed — flush remainder and exit.
                        send_batch(&client, &url, &api_key, &mut batch).await;
                        break;
                    }
                }
            }
            _ = ticker.tick() => {
                send_batch(&client, &url, &api_key, &mut batch).await;
            }
        }
    }
}

async fn send_batch(client: &reqwest::Client, url: &str, api_key: &str, batch: &mut Vec<Event>) {
    if batch.is_empty() {
        return;
    }
    let payload = std::mem::take(batch);
    let res = client
        .post(url)
        .bearer_auth(api_key)
        .json(&payload)
        .send()
        .await;
    match res {
        Ok(r) if r.status().is_success() => {}
        Ok(r) => log::warn!("telemetry ingest returned {} (dropped {} events)", r.status(), payload.len()),
        Err(e) => log::warn!("telemetry ingest failed: {e} (dropped {} events)", payload.len()),
    }
}

// ── HTTP access-log helpers (used by the middleware in main.rs) ───────────────

/// Best-effort client IP: Cloudflare's real-client header first (set at the
/// edge), else the connection's peer. Mirrors `auth::rate_limit::client_ip`.
pub fn req_ip(req: &ServiceRequest) -> String {
    if let Some(v) = req.headers().get("cf-connecting-ip").and_then(|v| v.to_str().ok()) {
        if !v.is_empty() {
            return v.to_string();
        }
    }
    req.connection_info()
        .realip_remote_addr()
        .unwrap_or("")
        .to_string()
}

/// Requests we deliberately don't access-log: preflight, health probes (hit
/// every few seconds by Docker), SSE buses, and the recorder WebSocket relay
/// (long-lived; a per-request row would be misleading).
pub fn http_skip(path: &str, method: &str) -> bool {
    method == "OPTIONS"
        || path == "/health"
        || path.ends_with("/events")
        || path.contains("/recorder/ws")
}

/// Emit one `http` access-log event. Severity tracks the status class.
pub fn log_http(method: &str, path: &str, status: u16, dur_ms: u32, ip: &str, ua: &str) {
    let severity = if status >= 500 {
        Severity::Error
    } else if status >= 400 {
        Severity::Warn
    } else {
        Severity::Info
    };
    Event::new("http", method, severity)
        .route(path)
        .status(status)
        .duration(dur_ms)
        .ip(ip)
        .user_agent(ua)
        .emit();
}

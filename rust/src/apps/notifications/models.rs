use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// A single alert definition stored in the `alerts` JSONB array on events/tasks.
// `offset_minutes` = how many minutes BEFORE the anchor (starts_at / due_at /
// occurrence time) to fire. 0 = "timer" (exactly at start). `channels` is
// optional; when absent the worker falls back to the user's global preferences.
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct Alert {
    pub offset_minutes: i64,
    #[serde(default)]
    pub channels: Option<Vec<String>>,
}

// ── A claimed, due scheduled-notification row (used by the worker) ──
#[derive(Debug, FromRow, Clone)]
pub struct ScheduledNotification {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub title: String,
    pub body: Option<String>,
    pub channels: Vec<String>,
    pub source_type: String,
    pub source_id: uuid::Uuid,
}

// ── Subscription / token registration DTOs ──

// Mirrors the browser PushSubscription.toJSON() shape.
#[derive(Debug, Deserialize)]
pub struct WebPushSubscribeRequest {
    pub endpoint: String,
    pub keys: WebPushKeys,
    #[serde(default)]
    pub user_agent: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct WebPushKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Debug, Deserialize)]
pub struct WebPushUnsubscribeRequest {
    pub endpoint: String,
}

#[derive(Debug, Deserialize)]
pub struct ExpoTokenRequest {
    pub token: String,
    #[serde(default)]
    pub platform: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct ExpoTokenDeleteRequest {
    pub token: String,
}

// ── Preferences ──

#[derive(Debug, Serialize, FromRow)]
pub struct NotificationPrefs {
    pub web_enabled: bool,
    pub push_enabled: bool,
}

#[derive(Debug, Deserialize)]
pub struct UpdatePrefsRequest {
    pub web: Option<bool>,
    pub push: Option<bool>,
}

// ── Error ──

#[derive(Debug, Serialize)]
pub struct NotificationsApiError {
    pub error: String,
}

#[derive(Debug, Serialize)]
pub struct VapidKeyResponse {
    pub key: String,
}

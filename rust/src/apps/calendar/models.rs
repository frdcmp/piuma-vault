use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ── DB Model ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct CalendarEvent {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub title: String,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: DateTime<Utc>,
    pub ends_at: Option<DateTime<Utc>>,
    pub all_day: bool,
    pub color: Option<String>,
    #[sqlx(default)]
    pub tags: Vec<String>,
    pub rrule: Option<String>,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Request DTOs ──

#[derive(Debug, Deserialize)]
pub struct CreateEventRequest {
    pub title: String,
    pub starts_at: DateTime<Utc>,
    #[serde(default)]
    pub description: Option<String>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub ends_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub all_day: bool,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub rrule: Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateEventRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub location: Option<String>,
    pub starts_at: Option<DateTime<Utc>>,
    pub ends_at: Option<Option<DateTime<Utc>>>,
    pub all_day: Option<bool>,
    pub color: Option<String>,
    pub tags: Option<Vec<String>>,
    pub rrule: Option<Option<String>>,
}

// Visible-range query. `from`/`to` are computed from the user's local view on
// the client and sent as UTC instants; the overlap test makes month/week/day
// fetches cheap.
#[derive(Debug, Deserialize)]
pub struct ListEventsQuery {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub tag: Option<String>,
}

// ── Error ──

#[derive(Debug, Serialize)]
pub struct CalendarApiError {
    pub error: String,
}

use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;

// ── Task DB Model ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Task {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub done: bool,
    pub completed_at: Option<DateTime<Utc>>,
    pub due_at: Option<DateTime<Utc>>,
    pub priority: i16,
    #[sqlx(default)]
    pub tags: Vec<String>,
    pub sort_order: i32,
    pub recurrence_id: Option<uuid::Uuid>,
    pub occurrence_date: Option<NaiveDate>,
    #[serde(default = "default_alerts")]
    pub alerts: serde_json::Value,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

pub fn default_alerts() -> serde_json::Value {
    serde_json::Value::Array(Vec::new())
}

#[derive(Debug, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub due_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub priority: i16,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default = "default_alerts")]
    pub alerts: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    // Double-Option: outer None = field omitted (keep); inner None = explicit null (clear).
    pub notes: Option<Option<String>>,
    pub due_at: Option<Option<DateTime<Utc>>>,
    pub priority: Option<i16>,
    pub tags: Option<Vec<String>>,
    pub sort_order: Option<i32>,
    pub done: Option<bool>,
    pub alerts: Option<serde_json::Value>,
}

#[derive(Debug, Deserialize)]
pub struct ListTasksQuery {
    pub done: Option<bool>,
    pub due_before: Option<DateTime<Utc>>,
    pub due_after: Option<DateTime<Utc>>,
    pub tag: Option<String>,
    // Filter to tasks carrying any tag that belongs to this bucket.
    pub bucket: Option<uuid::Uuid>,
}

// ── Recurring-task template DB Model ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct RecurringTask {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub title: String,
    pub notes: Option<String>,
    pub priority: i16,
    #[sqlx(default)]
    pub tags: Vec<String>,
    pub rrule: String,
    pub dtstart: DateTime<Utc>,
    pub until: Option<DateTime<Utc>>,
    pub active: bool,
    #[serde(default = "default_alerts")]
    pub alerts: serde_json::Value,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

#[derive(Debug, Deserialize)]
pub struct CreateRecurringTaskRequest {
    pub title: String,
    pub rrule: String,
    pub dtstart: DateTime<Utc>,
    #[serde(default)]
    pub notes: Option<String>,
    #[serde(default)]
    pub priority: i16,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub until: Option<DateTime<Utc>>,
    #[serde(default = "default_alerts")]
    pub alerts: serde_json::Value,
}

#[derive(Debug, Deserialize)]
pub struct UpdateRecurringTaskRequest {
    pub title: Option<String>,
    pub notes: Option<Option<String>>,
    pub priority: Option<i16>,
    pub tags: Option<Vec<String>>,
    pub rrule: Option<String>,
    pub dtstart: Option<DateTime<Utc>>,
    pub until: Option<Option<DateTime<Utc>>>,
    pub active: Option<bool>,
    pub alerts: Option<serde_json::Value>,
}

// Body for the occurrence complete/uncomplete endpoint. `done` defaults to true
// so a bare PUT marks the occurrence complete.
#[derive(Debug, Deserialize)]
pub struct CompleteOccurrenceRequest {
    #[serde(default = "default_true")]
    pub done: bool,
}

fn default_true() -> bool {
    true
}

// ── Error ──

#[derive(Debug, Serialize)]
pub struct TasksApiError {
    pub error: String,
}

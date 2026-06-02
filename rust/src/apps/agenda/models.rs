use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use crate::apps::calendar::models::CalendarEvent;
use crate::apps::tasks::models::Task;

// Visible-range query. `from`/`to` are UTC instants (half-open: [from, to)).
#[derive(Debug, Deserialize)]
pub struct AgendaQuery {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    pub tag: Option<String>,
}

// A single expanded recurring-task occurrence within the window. `done` reflects
// whether a materialized completion row exists for (recurrence_id, date).
#[derive(Debug, Serialize)]
pub struct AgendaOccurrence {
    pub recurrence_id: Uuid,
    pub occurrence_date: NaiveDate,
    pub title: String,
    pub notes: Option<String>,
    pub priority: i16,
    pub tags: Vec<String>,
    pub done: bool,
}

// One-call agenda overview combining everything scheduled in the window.
#[derive(Debug, Serialize)]
pub struct AgendaResponse {
    pub from: DateTime<Utc>,
    pub to: DateTime<Utc>,
    // One-off tasks (and materialized recurring completions carry due dates of
    // their own only when set) whose due_at falls inside the window.
    pub tasks: Vec<Task>,
    // Calendar events overlapping the window.
    pub events: Vec<CalendarEvent>,
    // Expanded recurring-task occurrences inside the window, with done status.
    pub recurring: Vec<AgendaOccurrence>,
}

#[derive(Debug, Serialize)]
pub struct AgendaError {
    pub error: String,
}

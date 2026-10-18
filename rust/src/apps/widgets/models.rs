use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};

// Optional horizon (in days, from "now") for upcoming tasks/events. The widget
// passes this so the home-screen surface can show e.g. today + the next few days.
// `from`/`to` (ISO instants) ask for `range_events`: every event overlapping that
// window, recurring ones expanded, for a month grid. Max 62 days.
#[derive(Debug, Deserialize)]
pub struct WidgetQuery {
    pub days: Option<i64>,
    pub from: Option<DateTime<Utc>>,
    pub to: Option<DateTime<Utc>>,
}

// A compact, widget-shaped task. Covers both one-off tasks (with `due_at`) and
// expanded recurring occurrences (with `occurrence_date`, `recurring = true`).
// Trimmed to only what a home-screen row needs — no notes/tags/full timestamps.
#[derive(Debug, Serialize)]
pub struct WidgetTask {
    pub id: String,
    pub title: String,
    pub due_at: Option<DateTime<Utc>>,
    pub occurrence_date: Option<NaiveDate>,
    pub priority: i16,
    pub overdue: bool,
    pub recurring: bool,
}

#[derive(Debug, Serialize)]
pub struct WidgetEvent {
    pub id: String,
    pub title: String,
    pub starts_at: DateTime<Utc>,
    pub ends_at: Option<DateTime<Utc>>,
    pub all_day: bool,
}

// One-call payload for the home-screen widgets. `now` is the server clock the
// widget formats against; sections are empty (not omitted) when the caller lacks
// the matching read scope, so the widget can render a stable shape either way.
#[derive(Debug, Serialize)]
pub struct WidgetSummary {
    pub now: DateTime<Utc>,
    pub tasks: Vec<WidgetTask>,
    pub events: Vec<WidgetEvent>,
    /// Only when `from`/`to` were given: all events overlapping that window
    /// (past ones included), for a calendar grid.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub range_events: Option<Vec<WidgetEvent>>,
}

#[derive(Debug, Serialize)]
pub struct WidgetError {
    pub error: String,
}

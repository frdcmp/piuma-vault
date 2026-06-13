//! Row structs + request DTOs for the cron app, plus the RRULE-based next-run
//! computation shared by the CRUD handlers (on create/update) and the worker.

use chrono::{DateTime, Duration, NaiveDateTime, TimeZone, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::agenda::recurrence::expand_dates;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct CronJobRow {
    pub id: Uuid,
    pub user_id: String,
    pub title: String,
    pub prompt: String,
    pub agent: String,
    pub conversation_id: Option<Uuid>,
    pub schedule_kind: String,
    pub rrule: Option<String>,
    pub dtstart: Option<DateTime<Utc>>,
    pub run_at: Option<DateTime<Utc>>,
    pub timezone: String,
    pub next_run_at: Option<DateTime<Utc>>,
    pub last_run_at: Option<DateTime<Utc>>,
    pub notify: bool,
    pub notify_channels: Vec<String>,
    pub allow_destructive: bool,
    pub enabled: bool,
    pub max_runtime_secs: i32,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct CronRunRow {
    pub id: Uuid,
    pub job_id: Uuid,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
    pub status: String,
    pub summary: Option<String>,
    pub message_id: Option<Uuid>,
    pub tools_used: Json,
    pub error: Option<String>,
    pub tokens_in: Option<i32>,
    pub tokens_out: Option<i32>,
}

fn default_true() -> bool {
    true
}

#[derive(Debug, Deserialize)]
pub struct CreateCronReq {
    pub title: String,
    pub prompt: String,
    #[serde(default)]
    pub agent: Option<String>,
    /// 'recurring' | 'once'
    pub schedule_kind: String,
    #[serde(default)]
    pub rrule: Option<String>,
    #[serde(default)]
    pub dtstart: Option<DateTime<Utc>>,
    #[serde(default)]
    pub run_at: Option<DateTime<Utc>>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default = "default_true")]
    pub notify: bool,
    #[serde(default)]
    pub notify_channels: Option<Vec<String>>,
    #[serde(default)]
    pub allow_destructive: bool,
    #[serde(default)]
    pub max_runtime_secs: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct UpdateCronReq {
    pub title: Option<String>,
    pub prompt: Option<String>,
    pub schedule_kind: Option<String>,
    pub rrule: Option<String>,
    pub dtstart: Option<DateTime<Utc>>,
    pub run_at: Option<DateTime<Utc>>,
    pub timezone: Option<String>,
    pub notify: Option<bool>,
    pub notify_channels: Option<Vec<String>>,
    pub allow_destructive: Option<bool>,
    pub enabled: Option<bool>,
    pub max_runtime_secs: Option<i32>,
}

/// Next fire time for a recurring job: the first RRULE occurrence date (expanded
/// via the shared agenda recurrence engine) combined with `dtstart`'s time-of-day
/// that lands strictly after `after`. Returns None if the rule is exhausted.
pub fn next_recurring(rrule: &str, dtstart: DateTime<Utc>, after: DateTime<Utc>) -> Option<DateTime<Utc>> {
    let time = dtstart.time();
    let range_start = after.date_naive();
    let range_end = range_start + Duration::days(420);
    for d in expand_dates(rrule, dtstart, None, range_start, range_end) {
        let dt = Utc.from_utc_datetime(&NaiveDateTime::new(d, time));
        if dt > after {
            return Some(dt);
        }
    }
    None
}

/// Compute `next_run_at` for any job shape. One-shot jobs fire at `run_at`
/// (None once it's in the past); recurring jobs use `next_recurring`.
pub fn compute_next_run(
    schedule_kind: &str,
    rrule: Option<&str>,
    dtstart: Option<DateTime<Utc>>,
    run_at: Option<DateTime<Utc>>,
    after: DateTime<Utc>,
) -> Option<DateTime<Utc>> {
    match schedule_kind {
        "once" => run_at.filter(|t| *t > after),
        _ => {
            let rrule = rrule?;
            let dtstart = dtstart.unwrap_or(after);
            next_recurring(rrule, dtstart, after)
        }
    }
}

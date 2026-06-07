//! Agenda tool — the unified "what's on my plate" view: one-off tasks due in a
//! window, calendar events overlapping it, and recurring tasks expanded
//! server-side (rrule) with their done status resolved. Mirrors the agenda
//! handler, reusing `expand_dates`.

use chrono::{DateTime, Duration, NaiveDate, Utc};
use serde_json::{json, Value};
use std::collections::HashSet;
use uuid::Uuid;

use super::*;
use crate::apps::agenda::recurrence::expand_dates;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "get_agenda",
        "The go-to tool for the user's calendar/schedule — answer ANY 'what's on my calendar / what's next / what do I have' question from here, NOT the web. Returns tasks due, calendar events, and recurring tasks expanded across a date range (ISO-8601). Defaults to the next 7 days; widen the range for 'next' questions if nothing is near.",
        json!({
            "type": "object",
            "properties": {
                "from": { "type": "string", "description": "range start, ISO-8601 (optional)" },
                "to": { "type": "string", "description": "range end, ISO-8601 (optional)" }
            }
        }),
    )]
}

pub async fn get_agenda(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let from = parse_dt(args, "from").unwrap_or_else(Utc::now);
    let to = parse_dt(args, "to").unwrap_or_else(|| Utc::now() + Duration::days(7));
    let range_start: NaiveDate = from.date_naive();
    let range_end: NaiveDate = to.date_naive();

    // One-off tasks due in the window.
    let task_rows: Vec<(Uuid, String, bool, Option<DateTime<Utc>>, i16, Vec<String>)> = sqlx::query_as(
        "SELECT id, title, done, due_at, priority, \
         (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_task_tags tt \
          JOIN db_tags tg ON tg.id = tt.tag_id WHERE tt.task_id = db_tasks.id) AS tags \
         FROM db_tasks \
         WHERE user_id = $1 AND recurrence_id IS NULL AND due_at >= $2 AND due_at < $3 \
         ORDER BY due_at",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let tasks: Vec<Value> = task_rows
        .into_iter()
        .map(|(id, title, done, due_at, priority, tags)| {
            json!({ "id": id, "title": title, "done": done, "due_at": due_at, "priority": priority, "tags": tags })
        })
        .collect();

    // Calendar events overlapping the window.
    let event_rows: Vec<(Uuid, String, DateTime<Utc>, Option<DateTime<Utc>>, bool, Option<String>)> =
        sqlx::query_as(
            "SELECT id, title, starts_at, ends_at, all_day, location FROM db_calendar_events \
             WHERE user_id = $1 AND starts_at < $2 AND COALESCE(ends_at, starts_at) >= $3 \
             ORDER BY starts_at",
        )
        .bind(user_id)
        .bind(to)
        .bind(from)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let events: Vec<Value> = event_rows
        .into_iter()
        .map(|(id, title, starts_at, ends_at, all_day, location)| {
            json!({ "id": id, "title": title, "starts_at": starts_at, "ends_at": ends_at, "all_day": all_day, "location": location })
        })
        .collect();

    // Completed recurring occurrences in the window (to mark expansions done).
    let done_rows: Vec<(Uuid, NaiveDate)> = sqlx::query_as(
        "SELECT recurrence_id, occurrence_date FROM db_tasks \
         WHERE user_id = $1 AND recurrence_id IS NOT NULL AND done = TRUE \
           AND occurrence_date BETWEEN $2 AND $3",
    )
    .bind(user_id)
    .bind(range_start)
    .bind(range_end)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let done_keys: HashSet<(Uuid, NaiveDate)> = done_rows.into_iter().collect();

    // Active recurring templates → expand across the window.
    let tmpl_rows: Vec<(Uuid, String, i16, Vec<String>, String, DateTime<Utc>, Option<DateTime<Utc>>)> =
        sqlx::query_as(
            "SELECT id, title, priority, \
             (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_recurring_task_tags rtt \
              JOIN db_tags tg ON tg.id = rtt.tag_id WHERE rtt.recurring_id = db_recurring_tasks.id) AS tags, \
             rrule, dtstart, until FROM db_recurring_tasks \
             WHERE user_id = $1 AND active = TRUE",
        )
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let mut recurring: Vec<Value> = Vec::new();
    for (id, title, priority, tags, rrule, dtstart, until) in tmpl_rows {
        for date in expand_dates(&rrule, dtstart, until, range_start, range_end) {
            recurring.push(json!({
                "recurrence_id": id,
                "occurrence_date": date,
                "title": title,
                "priority": priority,
                "tags": tags,
                "done": done_keys.contains(&(id, date)),
            }));
        }
    }

    Ok(json!({
        "from": from,
        "to": to,
        "tasks": tasks,
        "events": events,
        "recurring": recurring
    }))
}

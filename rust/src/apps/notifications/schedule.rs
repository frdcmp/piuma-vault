//! Alert-schedule materialization. Translates the `alerts` JSONB definitions on
//! an event / task / recurring template into concrete `db_scheduled_notifications`
//! rows (absolute `fire_at` instants) that the notification-worker polls.
//!
//! Called from the calendar/tasks handlers on create/update/delete, and from the
//! worker's rolling-window refill for recurring sources. Idempotent: it deletes
//! the source's *unsent* rows and re-inserts, using `ON CONFLICT DO NOTHING` so
//! already-sent rows for recurring occurrences are never resurrected.

use chrono::{DateTime, Duration, NaiveTime, Utc};
use uuid::Uuid;

use crate::apps::agenda::recurrence::expand_dates;
use crate::apps::notifications::models::Alert;
use crate::db::db::DbPool;

// How far ahead recurring occurrences are materialized. The worker re-runs this
// each tick, so the window keeps sliding forward.
const WINDOW_DAYS: i64 = 45;

const DEFAULT_CHANNELS: [&str; 2] = ["web", "push"];

fn parse_alerts(raw: &serde_json::Value) -> Vec<Alert> {
    serde_json::from_value::<Vec<Alert>>(raw.clone()).unwrap_or_default()
}

fn channels_for(alert: &Alert) -> Vec<String> {
    match &alert.channels {
        Some(c) if !c.is_empty() => c.clone(),
        _ => DEFAULT_CHANNELS.iter().map(|s| s.to_string()).collect(),
    }
}

fn offset_label(mins: i64) -> String {
    if mins <= 0 {
        return "Now".to_string();
    }
    if mins % 1440 == 0 {
        let d = mins / 1440;
        return format!("In {d} day{}", if d == 1 { "" } else { "s" });
    }
    if mins % 60 == 0 {
        let h = mins / 60;
        return format!("In {h} hour{}", if h == 1 { "" } else { "s" });
    }
    format!("In {mins} minutes")
}

#[allow(clippy::too_many_arguments)]
async fn insert_row(
    pool: &DbPool,
    user_id: &str,
    source_type: &str,
    source_id: Uuid,
    occurrence_date: Option<chrono::NaiveDate>,
    fire_at: DateTime<Utc>,
    offset_minutes: i64,
    title: &str,
    body: &str,
    channels: &[String],
) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO db_scheduled_notifications \
            (user_id, source_type, source_id, occurrence_date, fire_at, offset_minutes, title, body, channels) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) \
         ON CONFLICT (source_type, source_id, occurrence_date, offset_minutes) DO NOTHING",
    )
    .bind(user_id)
    .bind(source_type)
    .bind(source_id)
    .bind(occurrence_date)
    .bind(fire_at)
    .bind(offset_minutes as i32)
    .bind(title)
    .bind(body)
    .bind(channels)
    .execute(pool)
    .await?;
    Ok(())
}

/// Recompute the scheduled-notification rows for one source. `source_type` is
/// one of `"event"`, `"task"`, `"recurring"`. Best-effort: returns Err only on
/// hard DB failures; missing/empty sources simply clear their rows.
pub async fn reschedule_source(
    pool: &DbPool,
    source_type: &str,
    source_id: Uuid,
) -> Result<(), sqlx::Error> {
    // Wipe future unsent rows for this source; sent rows are preserved.
    sqlx::query(
        "DELETE FROM db_scheduled_notifications \
         WHERE source_type = $1 AND source_id = $2 AND sent_at IS NULL",
    )
    .bind(source_type)
    .bind(source_id)
    .execute(pool)
    .await?;

    let now = Utc::now();

    match source_type {
        "event" => {
            // user_id, title, starts_at, rrule, alerts
            let row: Option<(String, String, DateTime<Utc>, Option<String>, serde_json::Value)> =
                sqlx::query_as(
                    "SELECT user_id, title, starts_at, rrule, alerts \
                     FROM db_calendar_events WHERE id = $1",
                )
                .bind(source_id)
                .fetch_optional(pool)
                .await?;
            let Some((user_id, title, starts_at, rrule, alerts_raw)) = row else {
                return Ok(());
            };
            let alerts = parse_alerts(&alerts_raw);
            if alerts.is_empty() {
                return Ok(());
            }
            match rrule {
                Some(ref rr) if !rr.trim().is_empty() => {
                    materialize_recurring(
                        pool, &user_id, source_type, source_id, rr, starts_at, None, &alerts,
                        &title, now,
                    )
                    .await?;
                }
                _ => {
                    materialize_oneoff(
                        pool, &user_id, source_type, source_id, starts_at, &alerts, &title, now,
                    )
                    .await?;
                }
            }
        }
        "task" => {
            // Only one-off tasks (recurrence_id IS NULL) carry their own alerts;
            // materialized recurring completions are already done.
            let row: Option<(String, String, Option<DateTime<Utc>>, serde_json::Value)> =
                sqlx::query_as(
                    "SELECT user_id, title, due_at, alerts \
                     FROM db_tasks WHERE id = $1 AND recurrence_id IS NULL",
                )
                .bind(source_id)
                .fetch_optional(pool)
                .await?;
            let Some((user_id, title, due_at, alerts_raw)) = row else {
                return Ok(());
            };
            let Some(due_at) = due_at else {
                return Ok(());
            };
            let alerts = parse_alerts(&alerts_raw);
            materialize_oneoff(
                pool, &user_id, source_type, source_id, due_at, &alerts, &title, now,
            )
            .await?;
        }
        "recurring" => {
            // user_id, title, rrule, dtstart, until, active, alerts
            let row: Option<(
                String,
                String,
                String,
                DateTime<Utc>,
                Option<DateTime<Utc>>,
                bool,
                serde_json::Value,
            )> = sqlx::query_as(
                "SELECT user_id, title, rrule, dtstart, until, active, alerts \
                 FROM db_recurring_tasks WHERE id = $1",
            )
            .bind(source_id)
            .fetch_optional(pool)
            .await?;
            let Some((user_id, title, rrule, dtstart, until, active, alerts_raw)) = row else {
                return Ok(());
            };
            if !active {
                return Ok(());
            }
            let alerts = parse_alerts(&alerts_raw);
            if alerts.is_empty() {
                return Ok(());
            }
            materialize_recurring(
                pool, &user_id, source_type, source_id, &rrule, dtstart, until, &alerts, &title,
                now,
            )
            .await?;
        }
        _ => {}
    }

    Ok(())
}

async fn materialize_oneoff(
    pool: &DbPool,
    user_id: &str,
    source_type: &str,
    source_id: Uuid,
    anchor: DateTime<Utc>,
    alerts: &[Alert],
    title: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    for alert in alerts {
        let fire_at = anchor - Duration::minutes(alert.offset_minutes.max(0));
        if fire_at < now {
            continue; // never fire a past reminder
        }
        let channels = channels_for(alert);
        insert_row(
            pool,
            user_id,
            source_type,
            source_id,
            None,
            fire_at,
            alert.offset_minutes,
            title,
            &offset_label(alert.offset_minutes),
            &channels,
        )
        .await?;
    }
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn materialize_recurring(
    pool: &DbPool,
    user_id: &str,
    source_type: &str,
    source_id: Uuid,
    rrule: &str,
    dtstart: DateTime<Utc>,
    until: Option<DateTime<Utc>>,
    alerts: &[Alert],
    title: &str,
    now: DateTime<Utc>,
) -> Result<(), sqlx::Error> {
    let range_start = now.date_naive();
    let range_end = range_start + Duration::days(WINDOW_DAYS);
    let time_of_day: NaiveTime = dtstart.time();

    let dates = expand_dates(rrule, dtstart, until, range_start, range_end);
    for date in dates {
        // Combine occurrence date with the template's UTC time-of-day.
        let occ_dt = DateTime::<Utc>::from_naive_utc_and_offset(date.and_time(time_of_day), Utc);
        for alert in alerts {
            let fire_at = occ_dt - Duration::minutes(alert.offset_minutes.max(0));
            if fire_at < now {
                continue;
            }
            let channels = channels_for(alert);
            insert_row(
                pool,
                user_id,
                source_type,
                source_id,
                Some(date),
                fire_at,
                alert.offset_minutes,
                title,
                &offset_label(alert.offset_minutes),
                &channels,
            )
            .await?;
        }
    }
    Ok(())
}

/// Drop all scheduled rows for a source (used on delete).
pub async fn purge_source(
    pool: &DbPool,
    source_type: &str,
    source_id: Uuid,
) -> Result<(), sqlx::Error> {
    sqlx::query("DELETE FROM db_scheduled_notifications WHERE source_type = $1 AND source_id = $2")
        .bind(source_type)
        .bind(source_id)
        .execute(pool)
        .await?;
    Ok(())
}

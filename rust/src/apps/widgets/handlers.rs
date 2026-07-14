use std::collections::HashSet;

use actix_web::{web, HttpResponse, Responder};
use chrono::{DateTime, Duration, NaiveDate, TimeZone, Utc};
use uuid::Uuid;

use crate::apps::agenda::recurrence::expand_dates;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::{WidgetError, WidgetEvent, WidgetQuery, WidgetSummary, WidgetTask};

// Keep payloads small — a widget only shows a handful of rows, and the rest is
// noise on the wire and in AsyncStorage.
const TASK_CAP: usize = 25;
const EVENT_CAP: usize = 25;
const DEFAULT_DAYS: i64 = 7;
const MAX_DAYS: i64 = 31;

fn err(msg: impl Into<String>) -> WidgetError {
    WidgetError { error: msg.into() }
}

fn can_read_tasks(user: &AuthenticatedUser) -> bool {
    check_permission(user, "tasks.read") || check_permission(user, "tasks.manage")
}

fn can_read_calendar(user: &AuthenticatedUser) -> bool {
    check_permission(user, "calendar.read") || check_permission(user, "calendar.manage")
}

// Midnight-UTC instant for a date, used to merge date-based recurring
// occurrences into the same sort order as instant-based one-off due dates.
fn date_to_instant(d: NaiveDate) -> DateTime<Utc> {
    Utc.from_utc_datetime(&d.and_hms_opt(0, 0, 0).expect("valid midnight"))
}

/// GET /widgets/summary?days=N
///
/// Compact, capped overview for the Android home-screen widgets: open tasks
/// (overdue + due within the horizon, including expanded recurring occurrences)
/// and calendar events overlapping [now, now + N days). Each section is only
/// populated if the caller's scope allows reading it; both empty otherwise.
pub async fn summary(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<WidgetQuery>,
) -> impl Responder {
    let read_tasks = can_read_tasks(&user);
    let read_calendar = can_read_calendar(&user);
    if !read_tasks && !read_calendar {
        return HttpResponse::Forbidden().json(err(
            "Access denied: tasks or calendar read/manage permission required",
        ));
    }

    let now = Utc::now();
    let days = query.days.unwrap_or(DEFAULT_DAYS).clamp(1, MAX_DAYS);
    let horizon = now + Duration::days(days);
    let today: NaiveDate = now.date_naive();
    let horizon_date: NaiveDate = horizon.date_naive();

    // (sort instant, task) so one-off due dates and date-based recurring
    // occurrences merge into one chronologically ordered list.
    let mut tasks: Vec<(DateTime<Utc>, WidgetTask)> = Vec::new();

    if read_tasks {
        // One-off open tasks with a due date before the horizon (this captures
        // overdue, since overdue due_at < now < horizon).
        let one_off = sqlx::query_as::<_, (Uuid, String, Option<DateTime<Utc>>, i16)>(
            "SELECT id, title, due_at, priority FROM db_tasks \
             WHERE user_id = $1 AND done = FALSE AND due_at IS NOT NULL AND due_at < $2 \
             ORDER BY due_at ASC",
        )
        .bind(&user.user_id)
        .bind(horizon);
        match one_off.fetch_all(pool.get_ref()).await {
            Ok(rows) => {
                for (id, title, due_at, priority) in rows {
                    let due = due_at.expect("due_at filtered NOT NULL");
                    tasks.push((
                        due,
                        WidgetTask {
                            id: id.to_string(),
                            title,
                            due_at,
                            occurrence_date: None,
                            priority,
                            overdue: due < now,
                            recurring: false,
                        },
                    ));
                }
            }
            Err(e) => {
                log::error!("widgets one-off tasks query failed: {e}");
                return HttpResponse::InternalServerError().json(err("Failed to fetch tasks"));
            }
        }

        // Recurring templates → expand to concrete occurrences in [today, horizon].
        let templates = sqlx::query_as::<_, (Uuid, String, i16, String, DateTime<Utc>, Option<DateTime<Utc>>)>(
            "SELECT id, title, priority, rrule, dtstart, until FROM db_recurring_tasks \
             WHERE user_id = $1 AND active = TRUE",
        )
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await;
        let templates = match templates {
            Ok(rows) => rows,
            Err(e) => {
                log::error!("widgets recurring query failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to fetch recurring tasks"));
            }
        };

        // Occurrences already completed (materialized done rows), one query for all.
        let done_keys: HashSet<(Uuid, NaiveDate)> = match sqlx::query_as::<_, (Uuid, NaiveDate)>(
            "SELECT recurrence_id, occurrence_date FROM db_tasks \
             WHERE user_id = $1 AND recurrence_id IS NOT NULL AND done = TRUE \
               AND occurrence_date BETWEEN $2 AND $3",
        )
        .bind(&user.user_id)
        .bind(today)
        .bind(horizon_date)
        .fetch_all(pool.get_ref())
        .await
        {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                log::error!("widgets completions query failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to fetch occurrence completions"));
            }
        };

        for (id, title, priority, rrule, dtstart, until) in &templates {
            for date in expand_dates(rrule, *dtstart, *until, today, horizon_date) {
                if done_keys.contains(&(*id, date)) {
                    continue;
                }
                tasks.push((
                    date_to_instant(date),
                    WidgetTask {
                        id: id.to_string(),
                        title: title.clone(),
                        due_at: None,
                        occurrence_date: Some(date),
                        priority: *priority,
                        overdue: date < today,
                        recurring: true,
                    },
                ));
            }
        }
    }

    // Overdue first, then chronological; cap to keep the widget payload tight.
    tasks.sort_by(|a, b| a.0.cmp(&b.0));
    let tasks: Vec<WidgetTask> = tasks.into_iter().take(TASK_CAP).map(|(_, t)| t).collect();

    let mut events: Vec<WidgetEvent> = Vec::new();
    if read_calendar {
        // One-off events overlapping [now, horizon). Recurring templates are
        // excluded here and expanded below — their base starts_at is usually in
        // the past, so the overlap filter would drop them entirely.
        let rows = sqlx::query_as::<_, (Uuid, String, DateTime<Utc>, Option<DateTime<Utc>>, bool)>(
            "SELECT id, title, starts_at, ends_at, all_day FROM db_calendar_events \
             WHERE user_id = $1 AND rrule IS NULL \
               AND starts_at < $2 AND COALESCE(ends_at, starts_at) >= $3 \
             ORDER BY starts_at ASC",
        )
        .bind(&user.user_id)
        .bind(horizon)
        .bind(now)
        .fetch_all(pool.get_ref())
        .await;
        match rows {
            Ok(rows) => {
                events = rows
                    .into_iter()
                    .map(|(id, title, starts_at, ends_at, all_day)| WidgetEvent {
                        id: id.to_string(),
                        title,
                        starts_at,
                        ends_at,
                        all_day,
                    })
                    .collect();
            }
            Err(e) => {
                log::error!("widgets events query failed: {e}");
                return HttpResponse::InternalServerError().json(err("Failed to fetch events"));
            }
        }

        // Recurring events → concrete occurrences in the window, mirroring the
        // recurring-task expansion above. Each occurrence keeps the template's
        // UTC time-of-day and duration; UNTIL/COUNT live inside the rrule string
        // (events have no `until` column).
        let templates = sqlx::query_as::<_, (Uuid, String, DateTime<Utc>, Option<DateTime<Utc>>, bool, String)>(
            "SELECT id, title, starts_at, ends_at, all_day, rrule FROM db_calendar_events \
             WHERE user_id = $1 AND rrule IS NOT NULL AND starts_at < $2",
        )
        .bind(&user.user_id)
        .bind(horizon)
        .fetch_all(pool.get_ref())
        .await;
        let templates = match templates {
            Ok(rows) => rows,
            Err(e) => {
                log::error!("widgets recurring events query failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to fetch recurring events"));
            }
        };
        for (id, title, starts_at, ends_at, all_day, rrule) in &templates {
            let time_of_day = starts_at.time();
            let duration = ends_at.map(|e| e - *starts_at);
            for date in expand_dates(rrule, *starts_at, None, today, horizon_date) {
                let occ_start = Utc.from_utc_datetime(&date.and_time(time_of_day));
                let occ_end = duration.map(|d| occ_start + d);
                // Same overlap rule as the one-off SQL: upcoming or still ongoing.
                if occ_end.unwrap_or(occ_start) < now || occ_start >= horizon {
                    continue;
                }
                events.push(WidgetEvent {
                    id: id.to_string(),
                    title: title.clone(),
                    starts_at: occ_start,
                    ends_at: occ_end,
                    all_day: *all_day,
                });
            }
        }

        events.sort_by(|a, b| a.starts_at.cmp(&b.starts_at));
        events.truncate(EVENT_CAP);
    }

    HttpResponse::Ok().json(WidgetSummary { now, tasks, events })
}

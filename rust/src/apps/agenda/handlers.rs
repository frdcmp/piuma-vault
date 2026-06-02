use std::collections::HashSet;

use actix_web::{web, HttpResponse, Responder};
use chrono::{Duration, NaiveDate};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::calendar::models::CalendarEvent;
use crate::apps::tasks::models::{RecurringTask, Task};
use crate::db::db::DbPool;

use super::models::{AgendaError, AgendaOccurrence, AgendaQuery, AgendaResponse};
use super::recurrence::expand_dates;

const TASK_FIELDS: &str = "id, user_id, title, notes, done, completed_at, due_at, priority, \
     tags, sort_order, recurrence_id, occurrence_date, created_at, updated_at";

const RECURRING_FIELDS: &str = "id, user_id, title, notes, priority, tags, rrule, dtstart, \
     until, active, created_at, updated_at";

const EVENT_FIELDS: &str = "id, user_id, title, description, location, starts_at, ends_at, \
     all_day, color, tags, rrule, created_at, updated_at";

fn err(msg: impl Into<String>) -> AgendaError {
    AgendaError { error: msg.into() }
}

fn can_read_tasks(user: &AuthenticatedUser) -> bool {
    check_permission(user, "tasks.read") || check_permission(user, "tasks.manage")
}

fn can_read_calendar(user: &AuthenticatedUser) -> bool {
    check_permission(user, "calendar.read") || check_permission(user, "calendar.manage")
}

/// GET /admin/agenda?from=..&to=..[&tag=..]
///
/// Single-call overview for the half-open UTC window [from, to): one-off tasks
/// due in the window, calendar events overlapping it, and recurring-task
/// occurrences expanded server-side (with their done status). Each section is
/// only included if the caller's scope allows reading it.
pub async fn get_agenda(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<AgendaQuery>,
) -> impl Responder {
    let read_tasks = can_read_tasks(&user);
    let read_calendar = can_read_calendar(&user);
    if !read_tasks && !read_calendar {
        return HttpResponse::Forbidden().json(err(
            "Access denied: tasks or calendar read/manage permission required",
        ));
    }

    let from = query.from;
    let to = query.to;
    if to <= from {
        return HttpResponse::BadRequest().json(err("`to` must be after `from`"));
    }
    let tag = query.tag.clone();

    // Inclusive date window matching the half-open instant window [from, to).
    let range_start: NaiveDate = from.date_naive();
    let range_end: NaiveDate = (to - Duration::seconds(1)).date_naive();

    let mut tasks: Vec<Task> = Vec::new();
    let mut recurring: Vec<AgendaOccurrence> = Vec::new();

    if read_tasks {
        // ── One-off tasks due in the window ──
        let mut task_sql = format!(
            "SELECT {TASK_FIELDS} FROM db_tasks \
             WHERE user_id = $1 AND due_at >= $2 AND due_at < $3"
        );
        if tag.is_some() {
            task_sql.push_str(" AND $4 = ANY(tags)");
        }
        task_sql.push_str(" ORDER BY due_at ASC");

        let mut tq = sqlx::query_as::<_, Task>(&task_sql)
            .bind(&user.user_id)
            .bind(from)
            .bind(to);
        if let Some(ref t) = tag {
            tq = tq.bind(t);
        }
        match tq.fetch_all(pool.get_ref()).await {
            Ok(rows) => tasks = rows,
            Err(e) => {
                log::error!("agenda tasks query failed: {e}");
                return HttpResponse::InternalServerError().json(err("Failed to fetch tasks"));
            }
        }

        // ── Recurring templates → expand to concrete occurrences in window ──
        let mut tmpl_sql = format!(
            "SELECT {RECURRING_FIELDS} FROM db_recurring_tasks WHERE user_id = $1 AND active = TRUE"
        );
        if tag.is_some() {
            tmpl_sql.push_str(" AND $2 = ANY(tags)");
        }
        let mut tmplq = sqlx::query_as::<_, RecurringTask>(&tmpl_sql).bind(&user.user_id);
        if let Some(ref t) = tag {
            tmplq = tmplq.bind(t);
        }
        let templates = match tmplq.fetch_all(pool.get_ref()).await {
            Ok(rows) => rows,
            Err(e) => {
                log::error!("agenda recurring query failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to fetch recurring tasks"));
            }
        };

        // Which occurrences are already completed (one query for all templates).
        let done_keys: HashSet<(Uuid, NaiveDate)> = match sqlx::query_as::<_, (Uuid, NaiveDate)>(
            "SELECT recurrence_id, occurrence_date FROM db_tasks \
             WHERE user_id = $1 AND recurrence_id IS NOT NULL AND done = TRUE \
               AND occurrence_date BETWEEN $2 AND $3",
        )
        .bind(&user.user_id)
        .bind(range_start)
        .bind(range_end)
        .fetch_all(pool.get_ref())
        .await
        {
            Ok(rows) => rows.into_iter().collect(),
            Err(e) => {
                log::error!("agenda completions query failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to fetch occurrence completions"));
            }
        };

        for tmpl in &templates {
            for date in expand_dates(&tmpl.rrule, tmpl.dtstart, tmpl.until, range_start, range_end) {
                recurring.push(AgendaOccurrence {
                    recurrence_id: tmpl.id,
                    occurrence_date: date,
                    title: tmpl.title.clone(),
                    notes: tmpl.notes.clone(),
                    priority: tmpl.priority,
                    tags: tmpl.tags.clone(),
                    done: done_keys.contains(&(tmpl.id, date)),
                });
            }
        }
        recurring.sort_by(|a, b| {
            a.occurrence_date
                .cmp(&b.occurrence_date)
                .then_with(|| a.title.cmp(&b.title))
        });
    }

    let mut events: Vec<CalendarEvent> = Vec::new();
    if read_calendar {
        let mut ev_sql = format!(
            "SELECT {EVENT_FIELDS} FROM db_calendar_events \
             WHERE user_id = $1 AND starts_at < $2 AND COALESCE(ends_at, starts_at) >= $3"
        );
        if tag.is_some() {
            ev_sql.push_str(" AND $4 = ANY(tags)");
        }
        ev_sql.push_str(" ORDER BY starts_at ASC");

        let mut eq = sqlx::query_as::<_, CalendarEvent>(&ev_sql)
            .bind(&user.user_id)
            .bind(to)
            .bind(from);
        if let Some(ref t) = tag {
            eq = eq.bind(t);
        }
        match eq.fetch_all(pool.get_ref()).await {
            Ok(rows) => events = rows,
            Err(e) => {
                log::error!("agenda events query failed: {e}");
                return HttpResponse::InternalServerError().json(err("Failed to fetch events"));
            }
        }
    }

    HttpResponse::Ok().json(AgendaResponse {
        from,
        to,
        tasks,
        events,
        recurring,
    })
}

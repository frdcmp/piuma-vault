use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::{
    CalendarApiError, CalendarEvent, CreateEventRequest, ListEventsQuery, UpdateEventRequest,
};

const EVENT_FIELDS: &str = "id, user_id, title, description, location, starts_at, ends_at, \
     all_day, color, tags, rrule, created_at, updated_at";

fn err(msg: impl Into<String>) -> CalendarApiError {
    CalendarApiError { error: msg.into() }
}

fn require_read(user: &AuthenticatedUser) -> Option<HttpResponse> {
    // `calendar.manage` is the full-control scope for third-party calendar
    // managers; it satisfies both read and write. `admin_access` is handled by
    // check_permission.
    if check_permission(user, "calendar.read") || check_permission(user, "calendar.manage") {
        None
    } else {
        Some(HttpResponse::Forbidden().json(err(
            "Access denied: calendar.read or calendar.manage permission required",
        )))
    }
}

fn require_write(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if check_permission(user, "calendar.write") || check_permission(user, "calendar.manage") {
        None
    } else {
        Some(HttpResponse::Forbidden().json(err(
            "Access denied: calendar.write or calendar.manage permission required",
        )))
    }
}

fn validate_event(title: &str, tags: &[String]) -> Option<HttpResponse> {
    if title.trim().is_empty() {
        return Some(HttpResponse::BadRequest().json(err("Title is required")));
    }
    if title.len() > 500 {
        return Some(HttpResponse::BadRequest().json(err("Title must be 500 chars or fewer")));
    }
    if tags.len() > 20 {
        return Some(HttpResponse::BadRequest().json(err("Maximum 20 tags per event")));
    }
    None
}

// ── LIST (visible range) ────────────────────────────────────────────────────

pub async fn list_events(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<ListEventsQuery>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }

    // Overlap test: an event is visible if it starts before the window ends and
    // ends (or starts, if open-ended) at/after the window begins.
    let mut sql = format!(
        "SELECT {EVENT_FIELDS} FROM db_calendar_events \
         WHERE user_id = $1 AND starts_at < $2 AND COALESCE(ends_at, starts_at) >= $3"
    );
    if query.tag.is_some() {
        sql.push_str(" AND $4 = ANY(tags)");
    }
    sql.push_str(" ORDER BY starts_at");

    let mut q = sqlx::query_as::<_, CalendarEvent>(&sql)
        .bind(&user.user_id)
        .bind(query.to)
        .bind(query.from);
    if let Some(ref tag) = query.tag {
        q = q.bind(tag);
    }

    match q.fetch_all(pool.get_ref()).await {
        Ok(data) => HttpResponse::Ok().json(data),
        Err(e) => {
            log::error!("calendar list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch events"))
        }
    }
}

// ── CREATE ──────────────────────────────────────────────────────────────────

pub async fn create_event(
    user: AuthenticatedUser,
    body: web::Json<CreateEventRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    if let Some(r) = validate_event(&body.title, &body.tags) {
        return r;
    }
    if let Some(end) = body.ends_at {
        if end < body.starts_at {
            return HttpResponse::BadRequest().json(err("ends_at must be on or after starts_at"));
        }
    }

    let sql = format!(
        "INSERT INTO db_calendar_events \
         (user_id, title, description, location, starts_at, ends_at, all_day, color, tags, rrule) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING {EVENT_FIELDS}"
    );

    match sqlx::query_as::<_, CalendarEvent>(&sql)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(&body.description)
        .bind(&body.location)
        .bind(body.starts_at)
        .bind(body.ends_at)
        .bind(body.all_day)
        .bind(&body.color)
        .bind(&body.tags)
        .bind(&body.rrule)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(event) => HttpResponse::Created().json(event),
        Err(e) => {
            log::error!("calendar create failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to create event"))
        }
    }
}

// ── GET ─────────────────────────────────────────────────────────────────────

pub async fn get_event(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    let id = path.into_inner();
    let sql =
        format!("SELECT {EVENT_FIELDS} FROM db_calendar_events WHERE id = $1 AND user_id = $2");
    match sqlx::query_as::<_, CalendarEvent>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(event)) => HttpResponse::Ok().json(event),
        Ok(None) => HttpResponse::NotFound().json(err("Event not found")),
        Err(e) => {
            log::error!("calendar get failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch event"))
        }
    }
}

// ── UPDATE (partial) ──────────────────────────────────────────────────────────

pub async fn update_event(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateEventRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();

    if let Some(ref title) = body.title {
        if let Some(r) = validate_event(title, body.tags.as_deref().unwrap_or(&[])) {
            return r;
        }
    }

    // Partial update via COALESCE-style binds. Each Option maps to "keep existing
    // value when None". ends_at and rrule are double-Option so an explicit null
    // clears them while an omitted field keeps the stored value.
    let sql = format!(
        "UPDATE db_calendar_events SET \
            title = COALESCE($3, title), \
            description = CASE WHEN $4 THEN $5 ELSE description END, \
            location = CASE WHEN $6 THEN $7 ELSE location END, \
            starts_at = COALESCE($8, starts_at), \
            ends_at = CASE WHEN $9 THEN $10 ELSE ends_at END, \
            all_day = COALESCE($11, all_day), \
            color = CASE WHEN $12 THEN $13 ELSE color END, \
            tags = COALESCE($14, tags), \
            rrule = CASE WHEN $15 THEN $16 ELSE rrule END, \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {EVENT_FIELDS}"
    );

    let (set_desc, desc) = match &body.description {
        Some(v) => (true, Some(v.clone())),
        None => (false, None),
    };
    let (set_loc, loc) = match &body.location {
        Some(v) => (true, Some(v.clone())),
        None => (false, None),
    };
    let (set_ends, ends) = match &body.ends_at {
        Some(v) => (true, *v),
        None => (false, None),
    };
    let (set_color, color) = match &body.color {
        Some(v) => (true, Some(v.clone())),
        None => (false, None),
    };
    let (set_rrule, rrule) = match &body.rrule {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };

    match sqlx::query_as::<_, CalendarEvent>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(set_desc)
        .bind(desc)
        .bind(set_loc)
        .bind(loc)
        .bind(body.starts_at)
        .bind(set_ends)
        .bind(ends)
        .bind(body.all_day)
        .bind(set_color)
        .bind(color)
        .bind(&body.tags)
        .bind(set_rrule)
        .bind(rrule)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(event)) => HttpResponse::Ok().json(event),
        Ok(None) => HttpResponse::NotFound().json(err("Event not found")),
        Err(e) => {
            log::error!("calendar update failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to update event"))
        }
    }
}

// ── DELETE ──────────────────────────────────────────────────────────────────

pub async fn delete_event(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    match sqlx::query("DELETE FROM db_calendar_events WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() == 0 => {
            HttpResponse::NotFound().json(err("Event not found"))
        }
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("calendar delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete event"))
        }
    }
}

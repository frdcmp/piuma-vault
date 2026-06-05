use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::buckets::sync_tags;
use crate::apps::realtime::ResourceAction;
use crate::db::db::DbPool;

use super::events::CalendarEventBus;
use super::models::{
    CalendarApiError, CalendarEvent, CreateEventRequest, ListEventsQuery, UpdateEventRequest,
};

// `tags` is assembled from db_event_tags → db_tags as a name array (FromRow maps
// by name), so the API shape is unchanged.
const EVENT_FIELDS: &str = "id, user_id, title, description, location, starts_at, ends_at, \
     all_day, color, \
     (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_event_tags et \
      JOIN db_tags tg ON tg.id = et.tag_id WHERE et.event_id = db_calendar_events.id) AS tags, \
     rrule, alerts, created_at, updated_at";

fn err(msg: impl Into<String>) -> CalendarApiError {
    CalendarApiError { error: msg.into() }
}

async fn fetch_event(
    pool: &DbPool,
    id: Uuid,
    user_id: &str,
) -> Result<Option<CalendarEvent>, sqlx::Error> {
    sqlx::query_as::<_, CalendarEvent>(&format!(
        "SELECT {EVENT_FIELDS} FROM db_calendar_events WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

fn require_read(user: &AuthenticatedUser) -> Option<HttpResponse> {
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

// Best-effort (re)materialization of an event's alert schedule.
async fn reschedule(pool: &DbPool, event_id: Uuid) {
    if let Err(e) =
        crate::apps::notifications::schedule::reschedule_source(pool, "event", event_id).await
    {
        log::error!("calendar reschedule failed for {event_id}: {e}");
    }
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
        sql.push_str(
            " AND EXISTS (SELECT 1 FROM db_event_tags et JOIN db_tags tg ON tg.id = et.tag_id \
              WHERE et.event_id = db_calendar_events.id AND tg.name = $4)",
        );
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
    bus: web::Data<CalendarEventBus>,
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

    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO db_calendar_events \
         (user_id, title, description, location, starts_at, ends_at, all_day, color, rrule, alerts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
    )
    .bind(&user.user_id)
    .bind(&body.title)
    .bind(&body.description)
    .bind(&body.location)
    .bind(body.starts_at)
    .bind(body.ends_at)
    .bind(body.all_day)
    .bind(&body.color)
    .bind(&body.rrule)
    .bind(&body.alerts)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::error!("calendar create failed: {e}");
            return HttpResponse::BadRequest().json(err("Failed to create event"));
        }
    };

    if let Err(e) = sync_tags(pool.get_ref(), &user.user_id, "db_event_tags", "event_id", id, &body.tags).await {
        log::error!("event tag sync failed: {e}");
    }
    reschedule(pool.get_ref(), id).await;
    bus.publish(ResourceAction::Created, id);

    match fetch_event(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(event)) => HttpResponse::Created().json(event),
        _ => HttpResponse::InternalServerError().json(err("Created but failed to load event")),
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
    match fetch_event(pool.get_ref(), path.into_inner(), &user.user_id).await {
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
    bus: web::Data<CalendarEventBus>,
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

    // ends_at and rrule are double-Option so an explicit null clears them while an
    // omitted field keeps the stored value.
    let sql = "UPDATE db_calendar_events SET \
            title = COALESCE($3, title), \
            description = CASE WHEN $4 THEN $5 ELSE description END, \
            location = CASE WHEN $6 THEN $7 ELSE location END, \
            starts_at = COALESCE($8, starts_at), \
            ends_at = CASE WHEN $9 THEN $10 ELSE ends_at END, \
            all_day = COALESCE($11, all_day), \
            color = CASE WHEN $12 THEN $13 ELSE color END, \
            rrule = CASE WHEN $14 THEN $15 ELSE rrule END, \
            alerts = COALESCE($16, alerts), \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING id";

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

    let found: Option<Uuid> = match sqlx::query_scalar(sql)
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
        .bind(set_rrule)
        .bind(rrule)
        .bind(&body.alerts)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("calendar update failed: {e}");
            return HttpResponse::BadRequest().json(err("Failed to update event"));
        }
    };
    if found.is_none() {
        return HttpResponse::NotFound().json(err("Event not found"));
    }

    if let Some(ref tags) = body.tags {
        if let Err(e) = sync_tags(pool.get_ref(), &user.user_id, "db_event_tags", "event_id", id, tags).await {
            log::error!("event tag sync failed: {e}");
        }
    }
    reschedule(pool.get_ref(), id).await;
    bus.publish(ResourceAction::Updated, id);

    match fetch_event(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(event)) => HttpResponse::Ok().json(event),
        _ => HttpResponse::InternalServerError().json(err("Updated but failed to load event")),
    }
}

// ── DELETE ──────────────────────────────────────────────────────────────────

pub async fn delete_event(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
    bus: web::Data<CalendarEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    // db_event_tags rows cascade on delete.
    match sqlx::query("DELETE FROM db_calendar_events WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() == 0 => HttpResponse::NotFound().json(err("Event not found")),
        Ok(_) => {
            let _ =
                crate::apps::notifications::schedule::purge_source(pool.get_ref(), "event", id).await;
            bus.publish(ResourceAction::Deleted, id);
            HttpResponse::NoContent().finish()
        }
        Err(e) => {
            log::error!("calendar delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete event"))
        }
    }
}

//! Calendar tools — list / get / create / update events. Writes re-materialise
//! alert schedules via `reschedule_source`, mirroring the calendar handlers.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_events",
            "List calendar events overlapping a date range (ISO-8601). Defaults to the next 30 days. Recurring events are not expanded here — use get_agenda for that.",
            json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "range start, ISO-8601 (optional)" },
                    "to": { "type": "string", "description": "range end, ISO-8601 (optional)" }
                }
            }),
        ),
        (
            "get_event",
            "Get a single calendar event by id.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "event UUID" } },
                "required": ["id"]
            }),
        ),
        (
            "create_event",
            "Create a calendar event. starts_at/ends_at are ISO-8601.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "starts_at": { "type": "string", "description": "ISO-8601 start" },
                    "ends_at": { "type": "string", "description": "ISO-8601 end (optional)" },
                    "description": { "type": "string" },
                    "location": { "type": "string" },
                    "all_day": { "type": "boolean" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "rrule": { "type": "string", "description": "iCal RRULE (optional)" }
                },
                "required": ["title", "starts_at"]
            }),
        ),
        (
            "update_event",
            "Update a calendar event. Only provided fields change.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "event UUID" },
                    "title": { "type": "string" },
                    "starts_at": { "type": "string", "description": "ISO-8601" },
                    "ends_at": { "type": "string", "description": "ISO-8601" },
                    "description": { "type": "string" },
                    "location": { "type": "string" },
                    "all_day": { "type": "boolean" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "rrule": { "type": "string" }
                },
                "required": ["id"]
            }),
        ),
        (
            "delete_event",
            "Permanently delete a calendar event. Confirm with the user first — not recoverable.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "event UUID" } },
                "required": ["id"]
            }),
        ),
    ]
}

async fn reschedule(pool: &DbPool, event_id: Uuid) {
    if let Err(e) =
        crate::apps::notifications::schedule::reschedule_source(pool, "event", event_id).await
    {
        log::warn!("agent tools calendar reschedule failed for {event_id}: {e}");
    }
}

pub async fn list_events(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let from = parse_dt(args, "from").unwrap_or_else(Utc::now);
    let to = parse_dt(args, "to").unwrap_or_else(|| Utc::now() + Duration::days(30));
    let rows: Vec<(Uuid, String, DateTime<Utc>, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "SELECT id, title, starts_at, ends_at, location FROM db_calendar_events \
         WHERE user_id = $1 AND starts_at < $2 AND COALESCE(ends_at, starts_at) >= $3 \
         ORDER BY starts_at LIMIT 100",
    )
    .bind(user_id)
    .bind(to)
    .bind(from)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let count = rows.len();
    let events: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, starts_at, ends_at, location)| {
            json!({ "id": id, "title": title, "starts_at": starts_at, "ends_at": ends_at, "location": location })
        })
        .collect();
    Ok(json!({ "count": count, "events": events }))
}

pub async fn get_event(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let row: Option<(
        Uuid,
        String,
        Option<String>,
        Option<String>,
        DateTime<Utc>,
        Option<DateTime<Utc>>,
        bool,
        Vec<String>,
        Option<String>,
    )> = sqlx::query_as(
        "SELECT id, title, description, location, starts_at, ends_at, all_day, tags, rrule \
         FROM db_calendar_events WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, description, location, starts_at, ends_at, all_day, tags, rrule)) => Ok(json!({
            "id": id, "title": title, "description": description, "location": location,
            "starts_at": starts_at, "ends_at": ends_at, "all_day": all_day, "tags": tags, "rrule": rrule
        })),
        None => Err("event not found".into()),
    }
}

pub async fn create_event(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let title = req_str(args, "title")?;
    let starts_at = parse_dt(args, "starts_at").ok_or("`starts_at` must be an ISO-8601 timestamp")?;
    let ends_at = parse_dt(args, "ends_at");
    let description = opt_string(args, "description");
    let location = opt_string(args, "location");
    let all_day = opt_bool(args, "all_day").unwrap_or(false);
    let tags = opt_str_array(args, "tags").unwrap_or_default();
    let rrule = opt_string(args, "rrule");
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_calendar_events \
           (user_id, title, description, location, starts_at, ends_at, all_day, tags, rrule) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&description)
    .bind(&location)
    .bind(starts_at)
    .bind(ends_at)
    .bind(all_day)
    .bind(&tags)
    .bind(&rrule)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    reschedule(pool, id).await;
    Ok(json!({ "id": id, "title": title }))
}

pub async fn update_event(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let title = opt_string(args, "title");
    let starts_at = parse_dt(args, "starts_at");
    let ends_at = parse_dt(args, "ends_at");
    let description = opt_string(args, "description");
    let location = opt_string(args, "location");
    let all_day = opt_bool(args, "all_day");
    let tags = opt_str_array(args, "tags");
    let rrule = opt_string(args, "rrule");
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE db_calendar_events SET \
           title = COALESCE($3, title), \
           starts_at = COALESCE($4, starts_at), \
           ends_at = COALESCE($5, ends_at), \
           description = COALESCE($6, description), \
           location = COALESCE($7, location), \
           all_day = COALESCE($8, all_day), \
           tags = COALESCE($9, tags), \
           rrule = COALESCE($10, rrule), \
           updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING id, title",
    )
    .bind(id)
    .bind(user_id)
    .bind(&title)
    .bind(starts_at)
    .bind(ends_at)
    .bind(&description)
    .bind(&location)
    .bind(all_day)
    .bind(&tags)
    .bind(&rrule)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title)) => {
            reschedule(pool, id).await;
            Ok(json!({ "id": id, "title": title }))
        }
        None => Err("event not found".into()),
    }
}

pub async fn delete_event(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query("DELETE FROM db_calendar_events WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    if affected == 0 {
        return Err("event not found".into());
    }
    reschedule(pool, id).await;
    Ok(json!({ "id": id, "deleted": true }))
}

//! Tasks tools — one-off tasks and recurring templates. Writes re-materialise
//! alert schedules via `reschedule_source`, mirroring the tasks HTTP handlers.

use chrono::{DateTime, NaiveDate, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_tasks",
            "List the user's tasks. By default only pending (not-done) tasks.",
            json!({
                "type": "object",
                "properties": { "include_done": { "type": "boolean", "description": "include completed tasks too" } }
            }),
        ),
        (
            "get_task",
            "Get a single task by id (full detail incl. notes, priority, tags).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "task UUID" } },
                "required": ["id"]
            }),
        ),
        (
            "list_recurring",
            "List the user's recurring task templates (rrule, dtstart, active).",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "create_task",
            "Create a one-off task. due_at is ISO-8601.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due_at": { "type": "string", "description": "ISO-8601 timestamp (optional)" },
                    "priority": { "type": "integer", "description": "0 none, 1 low, 2 med, 3 high" },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title"]
            }),
        ),
        (
            "update_task",
            "Update a task. Only provided fields change.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "task UUID" },
                    "title": { "type": "string" },
                    "notes": { "type": "string" },
                    "due_at": { "type": "string", "description": "ISO-8601 timestamp" },
                    "priority": { "type": "integer" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "done": { "type": "boolean" }
                },
                "required": ["id"]
            }),
        ),
        (
            "toggle_task",
            "Flip a task's done state (done ↔ not done).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "task UUID" } },
                "required": ["id"]
            }),
        ),
        (
            "create_recurring",
            "Create a recurring task template. rrule is an iCal RRULE string; dtstart is ISO-8601.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "rrule": { "type": "string", "description": "e.g. FREQ=WEEKLY;BYDAY=MO" },
                    "dtstart": { "type": "string", "description": "ISO-8601 first occurrence" },
                    "notes": { "type": "string" },
                    "priority": { "type": "integer" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "until": { "type": "string", "description": "ISO-8601 end (optional)" }
                },
                "required": ["title", "rrule", "dtstart"]
            }),
        ),
        (
            "update_recurring",
            "Update a recurring task template. Only provided fields change.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "recurring template UUID" },
                    "title": { "type": "string" },
                    "rrule": { "type": "string" },
                    "dtstart": { "type": "string", "description": "ISO-8601" },
                    "notes": { "type": "string" },
                    "priority": { "type": "integer" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "active": { "type": "boolean" }
                },
                "required": ["id"]
            }),
        ),
        (
            "complete_occurrence",
            "Mark a single occurrence of a recurring task done (or undone) for a date.",
            json!({
                "type": "object",
                "properties": {
                    "recurrence_id": { "type": "string", "description": "recurring template UUID" },
                    "occurrence_date": { "type": "string", "description": "YYYY-MM-DD" },
                    "done": { "type": "boolean", "description": "default true" }
                },
                "required": ["recurrence_id", "occurrence_date"]
            }),
        ),
        (
            "delete_task",
            "Permanently delete a task. Confirm with the user first — this is not recoverable.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "task UUID" } },
                "required": ["id"]
            }),
        ),
        (
            "delete_recurring",
            "Permanently delete a recurring task template and its occurrences. Confirm first — not recoverable.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "recurring template UUID" } },
                "required": ["id"]
            }),
        ),
    ]
}

async fn reschedule(pool: &DbPool, source_type: &str, source_id: Uuid) {
    if let Err(e) =
        crate::apps::notifications::schedule::reschedule_source(pool, source_type, source_id).await
    {
        log::warn!("agent tools reschedule failed for {source_type} {source_id}: {e}");
    }
}

pub async fn list_tasks(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let include_done = opt_bool(args, "include_done").unwrap_or(false);
    let sql = if include_done {
        "SELECT id, title, done, due_at, priority FROM db_tasks WHERE user_id = $1 \
         ORDER BY done, due_at NULLS LAST, sort_order LIMIT 100"
    } else {
        "SELECT id, title, done, due_at, priority FROM db_tasks WHERE user_id = $1 AND done = FALSE \
         ORDER BY due_at NULLS LAST, sort_order LIMIT 100"
    };
    let rows: Vec<(Uuid, String, bool, Option<DateTime<Utc>>, i16)> =
        sqlx::query_as(sql).bind(user_id).fetch_all(pool).await.map_err(|e| e.to_string())?;
    let count = rows.len();
    let tasks: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, done, due_at, priority)| {
            json!({ "id": id, "title": title, "done": done, "due_at": due_at, "priority": priority })
        })
        .collect();
    Ok(json!({ "count": count, "tasks": tasks }))
}

pub async fn get_task(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let row: Option<(Uuid, String, Option<String>, bool, Option<DateTime<Utc>>, i16, Vec<String>)> =
        sqlx::query_as(
            "SELECT id, title, notes, done, due_at, priority, tags FROM db_tasks \
             WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, notes, done, due_at, priority, tags)) => Ok(json!({
            "id": id, "title": title, "notes": notes, "done": done,
            "due_at": due_at, "priority": priority, "tags": tags
        })),
        None => Err("task not found".into()),
    }
}

pub async fn list_recurring(pool: &DbPool, user_id: &str) -> Result<Value, String> {
    let rows: Vec<(Uuid, String, String, DateTime<Utc>, Option<DateTime<Utc>>, bool)> = sqlx::query_as(
        "SELECT id, title, rrule, dtstart, until, active FROM db_recurring_tasks \
         WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let count = rows.len();
    let recurring: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, rrule, dtstart, until, active)| {
            json!({ "id": id, "title": title, "rrule": rrule, "dtstart": dtstart, "until": until, "active": active })
        })
        .collect();
    Ok(json!({ "count": count, "recurring": recurring }))
}

pub async fn create_task(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let title = req_str(args, "title")?;
    let notes = opt_string(args, "notes");
    let due_at = parse_dt(args, "due_at");
    let priority = opt_i16(args, "priority").unwrap_or(0);
    let tags = opt_str_array(args, "tags").unwrap_or_default();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_tasks (user_id, title, notes, due_at, priority, tags) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(due_at)
    .bind(priority)
    .bind(&tags)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    reschedule(pool, "task", id).await;
    Ok(json!({ "id": id, "title": title }))
}

pub async fn update_task(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let title = opt_string(args, "title");
    let notes = opt_string(args, "notes");
    let due_at = parse_dt(args, "due_at");
    let priority = opt_i16(args, "priority");
    let tags = opt_str_array(args, "tags");
    let done = opt_bool(args, "done");
    let row: Option<(Uuid, String, bool)> = sqlx::query_as(
        "UPDATE db_tasks SET \
           title = COALESCE($3, title), \
           notes = COALESCE($4, notes), \
           due_at = COALESCE($5, due_at), \
           priority = COALESCE($6, priority), \
           tags = COALESCE($7, tags), \
           done = COALESCE($8, done), \
           completed_at = CASE WHEN $8 IS NULL THEN completed_at WHEN $8 THEN NOW() ELSE NULL END, \
           updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 \
         RETURNING id, title, done",
    )
    .bind(id)
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(due_at)
    .bind(priority)
    .bind(&tags)
    .bind(done)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, done)) => {
            reschedule(pool, "task", id).await;
            Ok(json!({ "id": id, "title": title, "done": done }))
        }
        None => Err("task not found".into()),
    }
}

pub async fn toggle_task(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as(
        "UPDATE db_tasks SET done = NOT done, \
           completed_at = CASE WHEN NOT done THEN NOW() ELSE NULL END, updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING id, title, done",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, done)) => {
            reschedule(pool, "task", id).await;
            Ok(json!({ "id": id, "title": title, "done": done }))
        }
        None => Err("task not found".into()),
    }
}

pub async fn create_recurring(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let title = req_str(args, "title")?;
    let rrule = req_str(args, "rrule")?;
    let dtstart = parse_dt(args, "dtstart").ok_or("`dtstart` must be an ISO-8601 timestamp")?;
    let notes = opt_string(args, "notes");
    let priority = opt_i16(args, "priority").unwrap_or(0);
    let tags = opt_str_array(args, "tags").unwrap_or_default();
    let until = parse_dt(args, "until");
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_recurring_tasks (user_id, title, notes, priority, tags, rrule, dtstart, until) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(priority)
    .bind(&tags)
    .bind(&rrule)
    .bind(dtstart)
    .bind(until)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    reschedule(pool, "recurring", id).await;
    Ok(json!({ "id": id, "title": title }))
}

pub async fn update_recurring(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let title = opt_string(args, "title");
    let rrule = opt_string(args, "rrule");
    let dtstart = parse_dt(args, "dtstart");
    let notes = opt_string(args, "notes");
    let priority = opt_i16(args, "priority");
    let tags = opt_str_array(args, "tags");
    let active = opt_bool(args, "active");
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE db_recurring_tasks SET \
           title = COALESCE($3, title), \
           rrule = COALESCE($4, rrule), \
           dtstart = COALESCE($5, dtstart), \
           notes = COALESCE($6, notes), \
           priority = COALESCE($7, priority), \
           tags = COALESCE($8, tags), \
           active = COALESCE($9, active), \
           updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING id, title",
    )
    .bind(id)
    .bind(user_id)
    .bind(&title)
    .bind(&rrule)
    .bind(dtstart)
    .bind(&notes)
    .bind(priority)
    .bind(&tags)
    .bind(active)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title)) => {
            reschedule(pool, "recurring", id).await;
            Ok(json!({ "id": id, "title": title }))
        }
        None => Err("recurring task not found".into()),
    }
}

pub async fn complete_occurrence(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let recurrence_id = uuid_arg(args, "recurrence_id")?;
    let date_str = req_str(args, "occurrence_date")?;
    let occurrence_date = NaiveDate::parse_from_str(&date_str, "%Y-%m-%d")
        .map_err(|_| "`occurrence_date` must be YYYY-MM-DD".to_string())?;
    let done = opt_bool(args, "done").unwrap_or(true);

    if !done {
        sqlx::query(
            "DELETE FROM db_tasks WHERE recurrence_id = $1 AND occurrence_date = $2 AND user_id = $3",
        )
        .bind(recurrence_id)
        .bind(occurrence_date)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
        return Ok(json!({ "recurrence_id": recurrence_id, "occurrence_date": date_str, "done": false }));
    }

    // Pull the template fields to materialise a completed occurrence row.
    let tmpl: Option<(String, Option<String>, i16, Vec<String>)> = sqlx::query_as(
        "SELECT title, notes, priority, tags FROM db_recurring_tasks WHERE id = $1 AND user_id = $2",
    )
    .bind(recurrence_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (title, notes, priority, tags) = tmpl.ok_or("recurring task not found")?;
    sqlx::query(
        "INSERT INTO db_tasks \
           (user_id, title, notes, done, completed_at, priority, tags, recurrence_id, occurrence_date) \
         VALUES ($1, $2, $3, TRUE, NOW(), $4, $5, $6, $7) \
         ON CONFLICT (recurrence_id, occurrence_date) \
         DO UPDATE SET done = TRUE, completed_at = NOW(), updated_at = NOW()",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(priority)
    .bind(&tags)
    .bind(recurrence_id)
    .bind(occurrence_date)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({ "recurrence_id": recurrence_id, "occurrence_date": date_str, "done": true }))
}

pub async fn delete_task(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query("DELETE FROM db_tasks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    if affected == 0 {
        return Err("task not found".into());
    }
    reschedule(pool, "task", id).await;
    Ok(json!({ "id": id, "deleted": true }))
}

pub async fn delete_recurring(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query("DELETE FROM db_recurring_tasks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    if affected == 0 {
        return Err("recurring task not found".into());
    }
    reschedule(pool, "recurring", id).await;
    Ok(json!({ "id": id, "deleted": true }))
}

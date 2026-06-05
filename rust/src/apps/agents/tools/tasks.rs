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
            "List the user's one-off tasks; each result includes its `tags` and current `bucket` name. By default only pending (not-done) tasks. Optionally filter by `tag` and/or `bucket` — e.g. list_tasks(tag: \"acp\") returns every task tagged acp with its bucket, so you can then re-bucket them with update_task.",
            json!({
                "type": "object",
                "properties": {
                    "include_done": { "type": "boolean", "description": "include completed tasks too" },
                    "tag": { "type": "string", "description": "only tasks carrying this tag (case-insensitive)" },
                    "bucket": { "type": "string", "description": "only tasks in this bucket, by bucket name (case-insensitive)" }
                }
            }),
        ),
        (
            "get_task",
            "Get a single task by id (full detail incl. notes, priority, tags, and bucket).",
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
                    "bucket": { "type": "string", "description": "bucket (task group) name to file this task under; created if it doesn't exist. Omit for no bucket." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "alerts": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "Reminder/alarm offsets in MINUTES BEFORE due_at; these fire push notifications + a full-screen alarm. 0 = ring exactly at due_at. e.g. [0] alarms at the due time, [10, 0] alarms 10 min before and at the due time. Requires due_at."
                    }
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
                    "bucket": { "type": "string", "description": "bucket (task group) name; created if missing. null/\"none\" removes the task from any bucket. Omit to leave unchanged." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "done": { "type": "boolean" },
                    "alerts": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "Replace the task's reminders/alarms. Minutes before due_at; 0 = at the due time. [] clears them. Requires due_at."
                    }
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
                    "bucket": { "type": "string", "description": "bucket (task group) name for generated occurrences; created if missing. Omit for no bucket." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "until": { "type": "string", "description": "ISO-8601 end (optional)" },
                    "alerts": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "Reminder/alarm offsets in minutes before each occurrence; 0 = at the occurrence time."
                    }
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
                    "bucket": { "type": "string", "description": "bucket (task group) name; created if missing. null/\"none\" clears it. Omit to leave unchanged." },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "active": { "type": "boolean" },
                    "alerts": {
                        "type": "array",
                        "items": { "type": "integer" },
                        "description": "Replace the template's reminders/alarms. Minutes before each occurrence; 0 = at the occurrence time. [] clears them."
                    }
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

/// Resolve the optional `bucket` arg (a bucket *name*) into an assignment.
/// `None` = key absent (keep current); `Some(None)` = clear (no bucket);
/// `Some(Some(id))` = set to this bucket (created by name if missing).
async fn bucket_arg(
    pool: &DbPool,
    user_id: &str,
    args: &Value,
) -> Result<Option<Option<Uuid>>, String> {
    match args.get("bucket") {
        None => Ok(None),
        Some(Value::String(s))
            if !s.trim().is_empty()
                && !s.eq_ignore_ascii_case("none")
                && !s.eq_ignore_ascii_case("inbox") =>
        {
            let id = crate::apps::buckets::find_or_create_bucket(pool, user_id, s.trim())
                .await
                .map_err(|e| e.to_string())?;
            Ok(Some(Some(id)))
        }
        // null, "", "none", "inbox", or a non-string → clear the bucket.
        Some(_) => Ok(Some(None)),
    }
}

/// Persist a bucket assignment computed by `bucket_arg` onto a task row.
async fn apply_bucket(
    pool: &DbPool,
    user_id: &str,
    table: &str,
    id: Uuid,
    bucket: Option<Option<Uuid>>,
) -> Result<(), String> {
    if let Some(b) = bucket {
        sqlx::query(&format!(
            "UPDATE {table} SET bucket_id = $1, updated_at = NOW() WHERE id = $2 AND user_id = $3"
        ))
        .bind(b)
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub async fn list_tasks(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let include_done = opt_bool(args, "include_done").unwrap_or(false);
    let tag = opt_string(args, "tag")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let bucket = opt_string(args, "bucket")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // One-off tasks only (materialized recurring occurrences are history). Each
    // row carries its bucket name + tag-name array so the agent can see and
    // re-organize without N extra get_task calls.
    let mut sql = String::from(
        "SELECT t.id, t.title, t.done, t.due_at, t.priority, b.name AS bucket, \
         (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_task_tags tt \
          JOIN db_tags tg ON tg.id = tt.tag_id WHERE tt.task_id = t.id) AS tags \
         FROM db_tasks t LEFT JOIN db_buckets b ON b.id = t.bucket_id \
         WHERE t.user_id = $1 AND t.recurrence_id IS NULL",
    );
    if !include_done {
        sql.push_str(" AND t.done = FALSE");
    }
    let mut idx = 2;
    if tag.is_some() {
        sql.push_str(&format!(
            " AND EXISTS (SELECT 1 FROM db_task_tags tt JOIN db_tags tg ON tg.id = tt.tag_id \
              WHERE tt.task_id = t.id AND lower(tg.name) = ${idx})"
        ));
        idx += 1;
    }
    if bucket.is_some() {
        sql.push_str(&format!(" AND lower(b.name) = lower(${idx})"));
    }
    sql.push_str(" ORDER BY t.done, t.due_at NULLS LAST, t.sort_order LIMIT 200");

    let mut q = sqlx::query_as::<_, (Uuid, String, bool, Option<DateTime<Utc>>, i16, Option<String>, Vec<String>)>(&sql)
        .bind(user_id);
    if let Some(ref tg) = tag {
        q = q.bind(tg);
    }
    if let Some(ref bk) = bucket {
        q = q.bind(bk);
    }
    let rows = q.fetch_all(pool).await.map_err(|e| e.to_string())?;
    let count = rows.len();
    let tasks: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, done, due_at, priority, bucket, tags)| {
            json!({ "id": id, "title": title, "done": done, "due_at": due_at, "priority": priority, "bucket": bucket, "tags": tags })
        })
        .collect();
    Ok(json!({ "count": count, "tasks": tasks }))
}

pub async fn get_task(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let row: Option<(Uuid, String, Option<String>, bool, Option<DateTime<Utc>>, i16, Option<String>, Vec<String>)> =
        sqlx::query_as(
            "SELECT t.id, t.title, t.notes, t.done, t.due_at, t.priority, b.name AS bucket, \
             (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_task_tags tt \
              JOIN db_tags tg ON tg.id = tt.tag_id WHERE tt.task_id = t.id) AS tags \
             FROM db_tasks t LEFT JOIN db_buckets b ON b.id = t.bucket_id \
             WHERE t.id = $1 AND t.user_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, notes, done, due_at, priority, bucket, tags)) => Ok(json!({
            "id": id, "title": title, "notes": notes, "done": done,
            "due_at": due_at, "priority": priority, "bucket": bucket, "tags": tags
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
    let alerts = parse_alerts(args, "alerts").unwrap_or_else(|| json!([]));
    if alerts.as_array().is_some_and(|a| !a.is_empty()) && due_at.is_none() {
        return Err("a due_at is required to set alerts/alarms".into());
    }
    let bucket_id = bucket_arg(pool, user_id, args).await?.flatten();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_tasks (user_id, title, notes, due_at, priority, bucket_id, alerts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(due_at)
    .bind(priority)
    .bind(bucket_id)
    .bind(&alerts)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    crate::apps::buckets::sync_tags(pool, user_id, "db_task_tags", "task_id", id, &tags)
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
    let alerts = parse_alerts(args, "alerts");
    let bucket = bucket_arg(pool, user_id, args).await?;
    let row: Option<(Uuid, String, bool)> = sqlx::query_as(
        "UPDATE db_tasks SET \
           title = COALESCE($3, title), \
           notes = COALESCE($4, notes), \
           due_at = COALESCE($5, due_at), \
           priority = COALESCE($6, priority), \
           done = COALESCE($7, done), \
           alerts = COALESCE($8, alerts), \
           completed_at = CASE WHEN $7 IS NULL THEN completed_at WHEN $7 THEN NOW() ELSE NULL END, \
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
    .bind(done)
    .bind(&alerts)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, done)) => {
            if let Some(t) = &tags {
                crate::apps::buckets::sync_tags(pool, user_id, "db_task_tags", "task_id", id, t)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            apply_bucket(pool, user_id, "db_tasks", id, bucket).await?;
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
    let alerts = parse_alerts(args, "alerts").unwrap_or_else(|| json!([]));
    let bucket_id = bucket_arg(pool, user_id, args).await?.flatten();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_recurring_tasks (user_id, title, notes, priority, bucket_id, rrule, dtstart, until, alerts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(priority)
    .bind(bucket_id)
    .bind(&rrule)
    .bind(dtstart)
    .bind(until)
    .bind(&alerts)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    crate::apps::buckets::sync_tags(pool, user_id, "db_recurring_task_tags", "recurring_id", id, &tags)
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
    let alerts = parse_alerts(args, "alerts");
    let bucket = bucket_arg(pool, user_id, args).await?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE db_recurring_tasks SET \
           title = COALESCE($3, title), \
           rrule = COALESCE($4, rrule), \
           dtstart = COALESCE($5, dtstart), \
           notes = COALESCE($6, notes), \
           priority = COALESCE($7, priority), \
           active = COALESCE($8, active), \
           alerts = COALESCE($9, alerts), \
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
    .bind(active)
    .bind(&alerts)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title)) => {
            if let Some(t) = &tags {
                crate::apps::buckets::sync_tags(pool, user_id, "db_recurring_task_tags", "recurring_id", id, t)
                    .await
                    .map_err(|e| e.to_string())?;
            }
            apply_bucket(pool, user_id, "db_recurring_tasks", id, bucket).await?;
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
    let tmpl: Option<(String, Option<String>, i16, Option<Uuid>, Vec<String>)> = sqlx::query_as(
        "SELECT title, notes, priority, bucket_id, \
         (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_recurring_task_tags rtt \
          JOIN db_tags tg ON tg.id = rtt.tag_id WHERE rtt.recurring_id = db_recurring_tasks.id) AS tags \
         FROM db_recurring_tasks WHERE id = $1 AND user_id = $2",
    )
    .bind(recurrence_id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let (title, notes, priority, bucket_id, tags) = tmpl.ok_or("recurring task not found")?;
    let task_id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_tasks \
           (user_id, title, notes, done, completed_at, priority, bucket_id, recurrence_id, occurrence_date) \
         VALUES ($1, $2, $3, TRUE, NOW(), $4, $5, $6, $7) \
         ON CONFLICT (recurrence_id, occurrence_date) \
         DO UPDATE SET done = TRUE, completed_at = NOW(), updated_at = NOW() \
         RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&notes)
    .bind(priority)
    .bind(bucket_id)
    .bind(recurrence_id)
    .bind(occurrence_date)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    crate::apps::buckets::sync_tags(pool, user_id, "db_task_tags", "task_id", task_id, &tags)
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

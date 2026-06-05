//! Buckets tools — buckets are top-level groups for **tasks** (e.g. "Work",
//! "Health"). A task belongs to at most one bucket (db_tasks.bucket_id). Tags
//! are separate flat labels and are NOT grouped by bucket. These tools let the
//! agent see and manage buckets; a task is put into a bucket via the `bucket`
//! field on create_task / update_task.

use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_buckets",
            "List the user's buckets (top-level groups for TASKS) with how many tasks each holds, plus the flat list of known tags. Use this before assigning a task to a bucket.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "create_bucket",
            "Create a new bucket (a group for tasks), e.g. 'Work' or 'Health'.",
            json!({
                "type": "object",
                "properties": {
                    "name": { "type": "string" },
                    "color": { "type": "string", "description": "optional hex color like #5cd0a9" }
                },
                "required": ["name"]
            }),
        ),
        (
            "rename_bucket",
            "Rename or recolor a bucket.",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "bucket UUID" },
                    "name": { "type": "string" },
                    "color": { "type": "string" }
                },
                "required": ["id"]
            }),
        ),
        (
            "delete_bucket",
            "Delete a bucket. Its tasks are NOT deleted — they fall back to no bucket. Confirm with the user first.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "bucket UUID" } },
                "required": ["id"]
            }),
        ),
    ]
}

// ── list_buckets: task groups (with task counts) + the flat tag list ─────────────

pub async fn list_buckets(pool: &DbPool, user_id: &str) -> Result<Value, String> {
    // bucket id, name, color, # of one-off tasks in it.
    let buckets: Vec<(Uuid, String, Option<String>, i64)> = sqlx::query_as(
        "SELECT b.id, b.name, b.color, \
            (SELECT COUNT(*) FROM db_tasks t \
             WHERE t.bucket_id = b.id AND t.recurrence_id IS NULL) AS tasks \
         FROM db_buckets b WHERE b.user_id = $1 ORDER BY b.sort_order, lower(b.name)",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    let tags: Vec<String> =
        sqlx::query_scalar("SELECT name FROM db_tags WHERE user_id = $1 ORDER BY lower(name)")
            .bind(user_id)
            .fetch_all(pool)
            .await
            .map_err(|e| e.to_string())?;

    let bucket_nodes: Vec<Value> = buckets
        .iter()
        .map(|(id, name, color, tasks)| {
            json!({ "id": id, "name": name, "color": color, "tasks": tasks })
        })
        .collect();

    Ok(json!({ "buckets": bucket_nodes, "tags": tags }))
}

// ── create_bucket ──────────────────────────────────────────────────────────────

pub async fn create_bucket(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let name = req_str(args, "name")?;
    let color = opt_string(args, "color");
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_buckets (user_id, name, color) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user_id)
    .bind(&name)
    .bind(&color)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({ "id": id, "name": name }))
}

// ── rename_bucket ────────────────────────────────────────────────────────────

pub async fn rename_bucket(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let name = opt_string(args, "name");
    let color = opt_string(args, "color");
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE db_buckets SET name = COALESCE($3, name), color = COALESCE($4, color), \
           updated_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id, name",
    )
    .bind(id)
    .bind(user_id)
    .bind(&name)
    .bind(&color)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, name)) => Ok(json!({ "id": id, "name": name })),
        None => Err("bucket not found".into()),
    }
}

// ── delete_bucket (tasks fall back to no bucket via ON DELETE SET NULL) ───────────

pub async fn delete_bucket(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query("DELETE FROM db_buckets WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    if affected == 0 {
        return Err("bucket not found".into());
    }
    Ok(json!({ "id": id, "deleted": true }))
}

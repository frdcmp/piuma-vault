//! Tool catalogue. Each tool is a thin wrapper over a direct query against the
//! user's data, scoped by `user_id` (so the agent only sees what the user can).
//! Read tools first (safe, high-value); write/agenda/storage/web come later.

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::db::DbPool;

/// (name, description, JSON-schema for parameters).
fn all_defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "search_notes",
            "Search the user's notes by keyword (matches title and body). Returns id, title, folder and a snippet for each hit.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "keywords to search for" },
                    "limit": { "type": "integer", "description": "max results (default 8)" }
                },
                "required": ["query"]
            }),
        ),
        (
            "read_note",
            "Read a note's full content by its id (get the id from search_notes first).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "note UUID" } },
                "required": ["id"]
            }),
        ),
        (
            "list_folders",
            "List the user's note folders.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "list_tasks",
            "List the user's tasks. By default only pending (not-done) tasks.",
            json!({
                "type": "object",
                "properties": { "include_done": { "type": "boolean", "description": "include completed tasks too" } }
            }),
        ),
        (
            "list_events",
            "List calendar events in a date range (ISO-8601 timestamps). Defaults to the next 30 days. Note: recurring events are not expanded yet.",
            json!({
                "type": "object",
                "properties": {
                    "from": { "type": "string", "description": "range start, ISO-8601 (optional)" },
                    "to": { "type": "string", "description": "range end, ISO-8601 (optional)" }
                }
            }),
        ),
    ]
}

/// OpenAI-format `tools` array for the enabled tool names.
pub fn schemas_for(enabled: &[String]) -> Vec<Value> {
    all_defs()
        .into_iter()
        .filter(|(name, _, _)| enabled.iter().any(|e| e == name))
        .map(|(name, desc, params)| {
            json!({
                "type": "function",
                "function": { "name": name, "description": desc, "parameters": params }
            })
        })
        .collect()
}

/// Execute a tool, returning a JSON result (serialised into the tool message).
pub async fn dispatch(pool: &DbPool, user_id: &str, name: &str, args: &Value) -> Result<Value, String> {
    match name {
        "search_notes" => search_notes(pool, user_id, args).await,
        "read_note" => read_note(pool, user_id, args).await,
        "list_folders" => list_folders(pool, user_id).await,
        "list_tasks" => list_tasks(pool, user_id, args).await,
        "list_events" => list_events(pool, user_id, args).await,
        other => Err(format!("unknown tool: {other}")),
    }
}

fn parse_dt(args: &Value, key: &str) -> Option<DateTime<Utc>> {
    args.get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

async fn search_notes(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let q = args.get("query").and_then(|v| v.as_str()).unwrap_or("").trim();
    if q.is_empty() {
        return Err("query is required".into());
    }
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(8).clamp(1, 25);
    let like = format!("%{q}%");
    let rows: Vec<(Uuid, String, String, String)> = sqlx::query_as(
        "SELECT id, title, COALESCE(folder, '/'), left(content, 240) FROM notes \
         WHERE user_id = $1 AND deleted_at IS NULL AND (title ILIKE $2 OR content ILIKE $2) \
         ORDER BY updated_at DESC LIMIT $3",
    )
    .bind(user_id)
    .bind(&like)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let count = rows.len();
    let results: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, folder, snippet)| json!({ "id": id, "title": title, "folder": folder, "snippet": snippet }))
        .collect();
    Ok(json!({ "count": count, "results": results }))
}

async fn read_note(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id_str = args.get("id").and_then(|v| v.as_str()).ok_or("id is required")?;
    let id = Uuid::parse_str(id_str).map_err(|_| "invalid note id".to_string())?;
    let row: Option<(String, String, String, Vec<String>)> = sqlx::query_as(
        "SELECT title, content, COALESCE(folder, '/'), tags FROM notes \
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((title, content, folder, tags)) => {
            Ok(json!({ "title": title, "content": content, "folder": folder, "tags": tags }))
        }
        None => Err("note not found".into()),
    }
}

async fn list_folders(pool: &DbPool, user_id: &str) -> Result<Value, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT COALESCE(folder, '/') FROM notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY 1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({ "folders": rows.into_iter().map(|(f,)| f).collect::<Vec<_>>() }))
}

async fn list_tasks(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let include_done = args.get("include_done").and_then(|v| v.as_bool()).unwrap_or(false);
    let sql = if include_done {
        "SELECT id, title, done, due_at FROM db_tasks WHERE user_id = $1 \
         ORDER BY done, due_at NULLS LAST, sort_order LIMIT 100"
    } else {
        "SELECT id, title, done, due_at FROM db_tasks WHERE user_id = $1 AND done = FALSE \
         ORDER BY due_at NULLS LAST, sort_order LIMIT 100"
    };
    let rows: Vec<(Uuid, String, bool, Option<DateTime<Utc>>)> = sqlx::query_as(sql)
        .bind(user_id)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    let count = rows.len();
    let tasks: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, done, due_at)| json!({ "id": id, "title": title, "done": done, "due_at": due_at }))
        .collect();
    Ok(json!({ "count": count, "tasks": tasks }))
}

async fn list_events(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let from = parse_dt(args, "from").unwrap_or_else(Utc::now);
    let to = parse_dt(args, "to").unwrap_or_else(|| Utc::now() + Duration::days(30));
    let rows: Vec<(Uuid, String, DateTime<Utc>, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "SELECT id, title, starts_at, ends_at, location FROM db_calendar_events \
         WHERE user_id = $1 AND starts_at >= $2 AND starts_at <= $3 ORDER BY starts_at LIMIT 100",
    )
    .bind(user_id)
    .bind(from)
    .bind(to)
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

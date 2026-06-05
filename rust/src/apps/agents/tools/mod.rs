//! Tool catalogue. Each tool is a thin wrapper over a direct query against the
//! user's data, scoped by `user_id` (so the agent only sees/does what the user
//! can). Tools are grouped by domain into submodules; this file owns the shared
//! arg helpers, the `schemas_for` filter, and the `dispatch` table.
//!
//! Tiers (per the plan, §9): Tier 1 read + Tier 2 create/edit + web are wired
//! into `vault_agent`'s subscription (registry). Tier 3 (deletes, shares,
//! storage writes, self-config) is intentionally not subscribed yet.

use chrono::{DateTime, Utc};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::db::db::DbPool;

mod agenda;
mod calendar;
mod notes;
mod storage;
mod tasks;
mod web;

/// (name, description, JSON-schema for parameters).
fn all_defs() -> Vec<(&'static str, &'static str, Value)> {
    let mut defs = Vec::new();
    defs.extend(notes::defs());
    defs.extend(tasks::defs());
    defs.extend(calendar::defs());
    defs.extend(agenda::defs());
    defs.extend(storage::defs());
    defs.extend(web::defs());
    defs
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
        // ── Notes ──
        "search_notes" => notes::search_notes(pool, user_id, args).await,
        "read_note" => notes::read_note(pool, user_id, args).await,
        "list_folders" => notes::list_folders(pool, user_id).await,
        "browse_folder" => notes::browse_folder(pool, user_id, args).await,
        "search_folders" => notes::search_folders(pool, user_id, args).await,
        "list_tags" => notes::list_tags(pool, user_id).await,
        "create_note" => notes::create_note(pool, user_id, args).await,
        "update_note" => notes::update_note(pool, user_id, args).await,
        "append_to_note" => notes::append_to_note(pool, user_id, args).await,
        // ── Tasks ──
        "list_tasks" => tasks::list_tasks(pool, user_id, args).await,
        "get_task" => tasks::get_task(pool, user_id, args).await,
        "list_recurring" => tasks::list_recurring(pool, user_id).await,
        "create_task" => tasks::create_task(pool, user_id, args).await,
        "update_task" => tasks::update_task(pool, user_id, args).await,
        "toggle_task" => tasks::toggle_task(pool, user_id, args).await,
        "create_recurring" => tasks::create_recurring(pool, user_id, args).await,
        "update_recurring" => tasks::update_recurring(pool, user_id, args).await,
        "complete_occurrence" => tasks::complete_occurrence(pool, user_id, args).await,
        // ── Calendar ──
        "list_events" => calendar::list_events(pool, user_id, args).await,
        "get_event" => calendar::get_event(pool, user_id, args).await,
        "create_event" => calendar::create_event(pool, user_id, args).await,
        "update_event" => calendar::update_event(pool, user_id, args).await,
        // ── Agenda ──
        "get_agenda" => agenda::get_agenda(pool, user_id, args).await,
        // ── Storage ──
        "list_storage" => storage::list_storage(pool, user_id, args).await,
        "signed_url" => storage::signed_url(pool, args).await,
        // ── Web ──
        "web_search" => web::web_search(pool, args).await,
        "web_fetch" => web::web_fetch(args).await,
        other => Err(format!("unknown tool: {other}")),
    }
}

// ── Shared arg helpers (used across the submodules) ──────────────────────────

pub(super) fn req_str(args: &Value, key: &str) -> Result<String, String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .ok_or_else(|| format!("`{key}` is required"))
}

pub(super) fn opt_string(args: &Value, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(|s| s.to_string())
}

pub(super) fn opt_i16(args: &Value, key: &str) -> Option<i16> {
    args.get(key).and_then(|v| v.as_i64()).map(|n| n as i16)
}

pub(super) fn opt_bool(args: &Value, key: &str) -> Option<bool> {
    args.get(key).and_then(|v| v.as_bool())
}

pub(super) fn opt_str_array(args: &Value, key: &str) -> Option<Vec<String>> {
    args.get(key).and_then(|v| v.as_array()).map(|a| {
        a.iter()
            .filter_map(|x| x.as_str().map(|s| s.to_string()))
            .collect()
    })
}

pub(super) fn uuid_arg(args: &Value, key: &str) -> Result<Uuid, String> {
    let s = req_str(args, key)?;
    Uuid::parse_str(&s).map_err(|_| format!("`{key}` must be a UUID"))
}

pub(super) fn parse_dt(args: &Value, key: &str) -> Option<DateTime<Utc>> {
    args.get(key)
        .and_then(|v| v.as_str())
        .and_then(|s| DateTime::parse_from_rfc3339(s).ok())
        .map(|d| d.with_timezone(&Utc))
}

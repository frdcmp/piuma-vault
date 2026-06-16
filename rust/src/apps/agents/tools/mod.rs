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
mod buckets;
mod calendar;
pub mod conversations;
mod db_backup;
mod email;
pub mod github;
mod image;
mod navigation;
pub mod memory;
mod notes;
mod recordings;
mod self_config;
mod shares;
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
    defs.extend(buckets::defs());
    defs.extend(storage::defs());
    defs.extend(shares::defs());
    defs.extend(self_config::defs());
    defs.extend(memory::defs());
    defs.extend(conversations::defs());
    defs.extend(web::defs());
    defs.extend(email::defs());
    defs.extend(github::defs());
    defs.extend(navigation::defs());
    defs.extend(recordings::defs());
    defs.extend(db_backup::defs());
    defs.extend(image::defs());
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
/// `agent` is the active agent kind — used to scope the self-config tools to
/// that agent's own rows.
pub async fn dispatch(
    pool: &DbPool,
    user_id: &str,
    agent: &str,
    name: &str,
    args: &Value,
) -> Result<Value, String> {
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
        "delete_note" => notes::delete_note(pool, user_id, args).await,
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
        "delete_task" => tasks::delete_task(pool, user_id, args).await,
        "delete_recurring" => tasks::delete_recurring(pool, user_id, args).await,
        // ── Calendar ──
        "list_events" => calendar::list_events(pool, user_id, args).await,
        "get_event" => calendar::get_event(pool, user_id, args).await,
        "create_event" => calendar::create_event(pool, user_id, args).await,
        "update_event" => calendar::update_event(pool, user_id, args).await,
        "delete_event" => calendar::delete_event(pool, user_id, args).await,
        // ── Agenda ──
        "get_agenda" => agenda::get_agenda(pool, user_id, args).await,
        // ── Buckets (task groups) ──
        "list_buckets" => buckets::list_buckets(pool, user_id).await,
        "create_bucket" => buckets::create_bucket(pool, user_id, args).await,
        "rename_bucket" => buckets::rename_bucket(pool, user_id, args).await,
        "delete_bucket" => buckets::delete_bucket(pool, user_id, args).await,
        // ── Storage ──
        "list_storage" => storage::list_storage(pool, user_id, args).await,
        "signed_url" => storage::signed_url(pool, args).await,
        "delete_object" => storage::delete_object(pool, args).await,
        "delete_folder" => storage::delete_folder(pool, args).await,
        "bulk_move" => storage::bulk_move(pool, args).await,
        "presign_upload" => storage::presign_upload(pool, args).await,
        "zip_bundle" => storage::zip_bundle(pool, args).await,
        // ── Shares ──
        "list_shares" => shares::list_shares(pool, user_id, args).await,
        "create_share" => shares::create_share(pool, user_id, args).await,
        "update_share" => shares::update_share(pool, user_id, args).await,
        "delete_share" => shares::delete_share(pool, user_id, args).await,
        // ── Self-config (scoped to the active agent) ──
        "read_self" => self_config::read_self(pool, agent).await,
        "update_instructions" => self_config::update_instructions(pool, agent, args).await,
        "update_user_context" => self_config::update_user_context(pool, agent, args).await,
        "update_memory" => self_config::update_memory(pool, agent, args).await,
        "update_persona" => self_config::update_persona(pool, agent, args).await,
        "context_add" => self_config::context_add(pool, agent, args).await,
        "context_replace" => self_config::context_replace(pool, agent, args).await,
        "context_remove" => self_config::context_remove(pool, agent, args).await,
        "context_list" => self_config::context_list(pool, agent, args).await,
        // ── Memory (L2 semantic store, scoped to the active agent) ──
        "memory_search" => memory::memory_search(pool, agent, args).await,
        "memory_save" => memory::memory_save(pool, agent, args).await,
        "memory_update" => memory::memory_update(pool, agent, args).await,
        "memory_delete" => memory::memory_delete(pool, agent, args).await,
        "memory_list" => memory::memory_list(pool, agent, args).await,
        "memory_confirm" => memory::memory_confirm(pool, agent, args).await,
        "memory_reject" => memory::memory_reject(pool, agent, args).await,
        "memory_related" => memory::memory_related(pool, agent, args).await,
        // ── Conversations (L3 FTS over chat history, scoped to the active agent) ──
        "search_conversations" => conversations::search_conversations(pool, agent, args).await,
        // ── Web ──
        "web_search" => web::web_search(pool, args).await,
        "web_fetch" => web::web_fetch(args).await,
        "send_email" => email::send_email(pool, user_id, args).await,
        "read_email" => email::read_email(pool, user_id, args).await,
        // ── GitHub (token from admin → Services) ──
        "github_list_repos" => github::list_repos(pool, args).await,
        "github_search_repos" => github::search_repos(pool, args).await,
        "github_read_file" => github::read_file(pool, args).await,
        "github_list_dir" => github::list_dir(pool, args).await,
        "github_list_commits" => github::list_commits(pool, args).await,
        "github_list_branches" => github::list_branches(pool, args).await,
        "github_list_issues" => github::list_issues(pool, args).await,
        "github_list_prs" => github::list_prs(pool, args).await,
        "github_create_or_update_file" => github::create_or_update_file(pool, args).await,
        "github_create_issue" => github::create_issue(pool, args).await,
        "github_create_branch" => github::create_branch(pool, args).await,
        "github_create_pull_request" => github::create_pull_request(pool, args).await,
        // ── Navigation (client renders a one-click "Go" action) ──
        "navigate" => navigation::navigate(args).await,
        // ── Recordings (transcript corpus: read + initiate) ──
        "list_recordings" => recordings::list_recordings(pool, user_id, args).await,
        "get_recording" => recordings::get_recording(pool, user_id, args).await,
        "start_recording" => recordings::start_recording(pool, user_id, args).await,
        // ── Database backup (full DB dump → S3; non-destructive) ──
        "backup_database" => db_backup::backup_database(pool, args).await,
        // ── Image generation (provider from admin → Services; result stored in S3) ──
        "generate_image" => image::generate_image(pool, user_id, args).await,
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

/// Normalise an `alerts` argument into the `[{ offset_minutes, channels? }]`
/// JSONB shape stored on tasks/events. Accepts either bare integers (minutes
/// before the anchor) or `{ offset_minutes, channels? }` objects. Returns
/// `None` when the key is absent (so callers can leave the column untouched on
/// update); `Some([])` for an explicit empty array.
pub(super) fn parse_alerts(args: &Value, key: &str) -> Option<Value> {
    let arr = args.get(key)?.as_array()?;
    let alerts: Vec<Value> = arr
        .iter()
        .filter_map(|v| {
            let offset = v
                .as_i64()
                .or_else(|| v.get("offset_minutes").and_then(|m| m.as_i64()))?;
            let mut obj = json!({ "offset_minutes": offset.max(0) });
            if let Some(ch) = v.get("channels") {
                obj["channels"] = ch.clone();
            }
            Some(obj)
        })
        .collect();
    Some(Value::Array(alerts))
}

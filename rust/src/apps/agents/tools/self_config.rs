//! Self-config tools (Tier 3) — let an agent read and rewrite ITS OWN editable
//! prose: `db_agent_profiles` (instructions / user_context / memory) and its
//! `db_agent_personas` row (system_prompt / display_name / emoji / allowed_tools).
//! Every query is scoped by the active `agent` kind, so an agent can never touch
//! another agent's config. Edits apply on the next request (rows re-read).

use serde_json::{json, Value};

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "read_self",
            "Read your own editable config: instructions, user_context, memory, and your persona (system prompt, allowed tools).",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "update_instructions",
            "Replace your own instructions (the always-loaded overview + tool guidance).",
            json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
        ),
        (
            "update_user_context",
            "Replace your own user_context scratchpad (notes about the user / project).",
            json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
        ),
        (
            "update_memory",
            "Replace your own persistent memory.",
            json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
        ),
        (
            "update_persona",
            "Update your own persona. Only provided fields change.",
            json!({
                "type": "object",
                "properties": {
                    "system_prompt": { "type": "string", "description": "who-you-are / voice" },
                    "display_name": { "type": "string" },
                    "emoji": { "type": "string" },
                    "allowed_tools": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "narrows your tools; omit to leave unchanged"
                    }
                }
            }),
        ),
        (
            "context_add",
            "Append one durable, always-relevant fact to your always-in-context scratchpad. \
             Use this (not memory_save) only for the handful of facts you need EVERY turn; \
             memory_save is for everything topic-specific. Hard-capped — if full, the call is \
             rejected with your current entries so you can consolidate via context_replace first.",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "target": { "type": "string", "description": "memory (default) | user_context" }
                },
                "required": ["text"]
            }),
        ),
        (
            "context_replace",
            "Substring-replace in your always-in-context scratchpad — the primary way to compact \
             (merge related entries into one).",
            json!({
                "type": "object",
                "properties": {
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" },
                    "target": { "type": "string", "description": "memory (default) | user_context" }
                },
                "required": ["old_text", "new_text"]
            }),
        ),
        (
            "context_remove",
            "Remove a fact from your always-in-context scratchpad by substring match.",
            json!({
                "type": "object",
                "properties": {
                    "text": { "type": "string" },
                    "target": { "type": "string", "description": "memory (default) | user_context" }
                },
                "required": ["text"]
            }),
        ),
        (
            "context_list",
            "Show your always-in-context scratchpad with usage stats (chars / cap / %).",
            json!({
                "type": "object",
                "properties": {
                    "target": { "type": "string", "description": "memory (default) | user_context" }
                }
            }),
        ),
    ]
}

// ── L1 always-in-context scratchpad (context_* tools) ────────────────────────

/// Char cap per field (memory = agent scratchpad, user_context = user profile).
fn cap_for(target: &str) -> usize {
    match target {
        "user_context" => 1375,
        _ => 2200,
    }
}

/// Validate + normalise the `target` arg to a real column name.
fn target_col(args: &Value) -> Result<&'static str, String> {
    match opt_string(args, "target").as_deref() {
        None | Some("memory") => Ok("memory"),
        Some("user_context") => Ok("user_context"),
        Some(other) => Err(format!("invalid target '{other}' (use memory | user_context)")),
    }
}

/// Normalise a line for duplicate detection: lowercase, keep alphanumerics +
/// spaces, collapse runs of whitespace.
fn normalize(s: &str) -> String {
    let lowered: String = s
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { ' ' })
        .collect();
    lowered.split_whitespace().collect::<Vec<_>>().join(" ")
}

async fn get_field(pool: &DbPool, agent: &str, column: &str) -> Result<String, String> {
    let sql = format!("SELECT {column} FROM db_agent_profiles WHERE agent = $1");
    let row: Option<(String,)> = sqlx::query_as(&sql)
        .bind(agent)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|(v,)| v).ok_or_else(|| "agent profile not found".into())
}

fn entries_of(field: &str) -> Vec<String> {
    field.lines().map(|l| l.to_string()).filter(|l| !l.trim().is_empty()).collect()
}

pub async fn context_list(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let column = target_col(args)?;
    let field = get_field(pool, agent, column).await?;
    let cap = cap_for(column);
    let chars = field.chars().count();
    Ok(json!({
        "target": column,
        "content": field,
        "entries": entries_of(&field),
        "chars": chars,
        "cap": cap,
        "pct": (chars * 100 / cap).min(100)
    }))
}

pub async fn context_add(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let column = target_col(args)?;
    let text = req_str(args, "text")?;
    let field = get_field(pool, agent, column).await?;
    let cap = cap_for(column);

    // Normalised duplicate check against existing lines.
    let norm = normalize(&text);
    if let Some(dup) = entries_of(&field).into_iter().find(|l| normalize(l) == norm) {
        return Ok(json!({ "duplicate": true, "existing": dup }));
    }

    let new_field = if field.trim().is_empty() {
        text.clone()
    } else {
        format!("{field}\n{text}")
    };
    let new_len = new_field.chars().count();
    if new_len > cap {
        return Ok(json!({
            "rejected": true,
            "reason": format!(
                "{} at {}/{} chars. Adding this entry ({} chars) would exceed the limit. \
                 Replace or remove existing entries first.",
                column, field.chars().count(), cap, text.chars().count()
            ),
            "chars": field.chars().count(),
            "cap": cap,
            "entries": entries_of(&field)
        }));
    }
    set_profile_field(pool, agent, column, &new_field).await?;
    Ok(json!({ "added": true, "target": column, "chars": new_len, "cap": cap }))
}

pub async fn context_replace(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let column = target_col(args)?;
    let old_text = req_str(args, "old_text")?;
    let new_text = req_str(args, "new_text")?;
    let field = get_field(pool, agent, column).await?;
    if !field.contains(&old_text) {
        return Err("old_text not found in the scratchpad".into());
    }
    let new_field = field.replace(&old_text, &new_text);
    let cap = cap_for(column);
    let new_len = new_field.chars().count();
    if new_len > cap {
        return Ok(json!({
            "rejected": true,
            "reason": format!("Replacement would put {column} at {new_len}/{cap} chars."),
            "cap": cap
        }));
    }
    set_profile_field(pool, agent, column, &new_field).await?;
    Ok(json!({ "replaced": true, "target": column, "chars": new_len, "cap": cap }))
}

pub async fn context_remove(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let column = target_col(args)?;
    let text = req_str(args, "text")?;
    let field = get_field(pool, agent, column).await?;
    if !field.contains(&text) {
        return Err("text not found in the scratchpad".into());
    }
    // Remove the substring, then drop any blank lines it left behind.
    let stripped = field.replace(&text, "");
    let new_field = stripped
        .lines()
        .filter(|l| !l.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    set_profile_field(pool, agent, column, &new_field).await?;
    Ok(json!({ "removed": true, "target": column, "chars": new_field.chars().count() }))
}

pub async fn read_self(pool: &DbPool, agent: &str) -> Result<Value, String> {
    let profile: Option<(String, String, String, String)> = sqlx::query_as(
        "SELECT display_name, instructions, user_context, memory FROM db_agent_profiles WHERE agent = $1",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let persona: Option<(String, String, Option<String>, String, Option<Vec<String>>)> =
        sqlx::query_as(
            "SELECT name, display_name, emoji, system_prompt, allowed_tools FROM db_agent_personas \
             WHERE agent = $1 ORDER BY created_at LIMIT 1",
        )
        .bind(agent)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let (display_name, instructions, user_context, memory) =
        profile.ok_or("agent profile not found")?;
    let persona_json = persona.map(|(name, pdisplay, emoji, system_prompt, allowed_tools)| {
        json!({
            "name": name, "display_name": pdisplay, "emoji": emoji,
            "system_prompt": system_prompt, "allowed_tools": allowed_tools
        })
    });
    Ok(json!({
        "agent": agent,
        "display_name": display_name,
        "instructions": instructions,
        "user_context": user_context,
        "memory": memory,
        "persona": persona_json
    }))
}

async fn set_profile_field(pool: &DbPool, agent: &str, column: &str, text: &str) -> Result<Value, String> {
    // `column` is a fixed internal literal (never user input), so this is safe.
    let sql = format!("UPDATE db_agent_profiles SET {column} = $2, updated_at = NOW() WHERE agent = $1");
    let affected = sqlx::query(&sql)
        .bind(agent)
        .bind(text)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
    if affected == 0 {
        return Err("agent profile not found".into());
    }
    Ok(json!({ "agent": agent, "updated": column }))
}

pub async fn update_instructions(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let text = req_str(args, "text")?;
    set_profile_field(pool, agent, "instructions", &text).await
}

pub async fn update_user_context(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let text = req_str(args, "text")?;
    set_profile_field(pool, agent, "user_context", &text).await
}

pub async fn update_memory(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let text = req_str(args, "text")?;
    set_profile_field(pool, agent, "memory", &text).await
}

pub async fn update_persona(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let system_prompt = opt_string(args, "system_prompt");
    let display_name = opt_string(args, "display_name");
    let emoji = opt_string(args, "emoji");
    let allowed_tools = opt_str_array(args, "allowed_tools");
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE db_agent_personas SET \
           system_prompt = COALESCE($2, system_prompt), \
           display_name = COALESCE($3, display_name), \
           emoji = COALESCE($4, emoji), \
           allowed_tools = COALESCE($5, allowed_tools), \
           updated_at = NOW() \
         WHERE agent = $1 RETURNING name",
    )
    .bind(agent)
    .bind(&system_prompt)
    .bind(&display_name)
    .bind(&emoji)
    .bind(&allowed_tools)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((name,)) => Ok(json!({ "agent": agent, "persona": name, "updated": true })),
        None => Err("agent persona not found".into()),
    }
}

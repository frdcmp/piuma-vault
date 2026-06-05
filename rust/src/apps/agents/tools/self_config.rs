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
    ]
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

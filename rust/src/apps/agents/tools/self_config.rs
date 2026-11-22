//! Self-config tools (Tier 3) — let an agent read and rewrite ITS OWN editable
//! prose: `db_agent_profiles` (instructions, and the profile of the user: L1, `profile`) and its
//! `db_agent_personas` row (system_prompt / display_name / emoji).
//! Every query is scoped by the active `agent` kind, so an agent can never touch
//! another agent's config. Edits apply on the next request (rows re-read).

use serde_json::{json, Value};

use super::*;
use crate::apps::agents::profile;
use crate::db::db::DbPool;

/// context_add's description: what the profile is for, and its sections.
static CONTEXT_ADD: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    format!(
        "Add one fact to your profile of the user. It is in every prompt and holds what any \
         assistant needs to answer any message from them well, whatever it's about. A fact goes \
         under one of its sections: {}. Hard-capped at {} characters: when full, the call returns \
         the profile so you can merge facts with context_replace first.",
        profile::described(),
        profile::CAP
    )
});

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "read_self",
            "Read your own editable config: instructions, your profile of the user, and your persona (system prompt, allowed tools).",
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
            "update_persona",
            "Update your own persona. Only provided fields change.",
            json!({
                "type": "object",
                "properties": {
                    "system_prompt": { "type": "string", "description": "who-you-are / voice" },
                    "display_name": { "type": "string" },
                    "emoji": { "type": "string" }
                }
            }),
        ),
        (
            "context_add",
            CONTEXT_ADD.as_str(),
            json!({
                "type": "object",
                "properties": {
                    "section": { "type": "string", "enum": ["who", "answers", "organised"] },
                    "text": { "type": "string", "description": "one fact, one line" }
                },
                "required": ["section", "text"]
            }),
        ),
        (
            "context_replace",
            "Replace text in your profile of the user (it is in every prompt): correct a fact, or merge two into one.",
            json!({
                "type": "object",
                "properties": {
                    "old_text": { "type": "string" },
                    "new_text": { "type": "string" }
                },
                "required": ["old_text", "new_text"]
            }),
        ),
        (
            "context_remove",
            "Remove a fact from your profile of the user (it is in every prompt) by substring match.",
            json!({
                "type": "object",
                "properties": { "text": { "type": "string" } },
                "required": ["text"]
            }),
        ),
        (
            "context_list",
            "Show your profile of the user, its facts by section, and its size against the cap.",
            json!({ "type": "object", "properties": {} }),
        ),
    ]
}

// ── L1: the profile of the user (context_* tools, `profile`) ──────────────────

const PROFILE: &str = "user_context";

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

async fn get_profile(pool: &DbPool, agent: &str) -> Result<String, String> {
    let row: Option<(String,)> = sqlx::query_as("SELECT user_context FROM db_agent_profiles WHERE agent = $1")
        .bind(agent)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    row.map(|(v,)| v).ok_or_else(|| "agent profile not found".into())
}

fn facts_json(p: &str) -> Value {
    json!(profile::facts(p).into_iter().map(|(section, fact)| json!({ "section": section, "fact": fact })).collect::<Vec<_>>())
}

pub async fn context_list(pool: &DbPool, agent: &str, _args: &Value) -> Result<Value, String> {
    let p = get_profile(pool, agent).await?;
    let chars = p.chars().count();
    Ok(json!({
        "content": p,
        "facts": facts_json(&p),
        "chars": chars,
        "cap": profile::CAP,
        "pct": (chars * 100 / profile::CAP).min(100)
    }))
}

pub async fn context_add(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let section = profile::section(&req_str(args, "section")?)?;
    let text = req_str(args, "text")?;
    let p = get_profile(pool, agent).await?;

    // Normalised duplicate check against the facts held.
    let norm = normalize(&text);
    if let Some((_, dup)) = profile::facts(&p).into_iter().find(|(_, f)| normalize(f) == norm) {
        return Ok(json!({ "duplicate": true, "existing": dup }));
    }

    let new_profile = profile::with_line(&p, section, &text);
    let new_len = new_profile.chars().count();
    if new_len > profile::CAP {
        return Ok(json!({
            "rejected": true,
            "reason": format!(
                "The profile is at {}/{} chars; this fact ({} chars) would exceed the limit. \
                 Merge or remove facts first.",
                p.chars().count(), profile::CAP, text.chars().count()
            ),
            "chars": p.chars().count(),
            "cap": profile::CAP,
            "facts": facts_json(&p)
        }));
    }
    set_profile_field(pool, agent, PROFILE, &new_profile).await?;
    Ok(json!({ "added": true, "section": section.key, "chars": new_len, "cap": profile::CAP }))
}

pub async fn context_replace(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let old_text = req_str(args, "old_text")?;
    let new_text = req_str(args, "new_text")?;
    let p = get_profile(pool, agent).await?;
    if !p.contains(&old_text) {
        return Err("old_text not found in the profile".into());
    }
    let new_profile = p.replace(&old_text, &new_text);
    let new_len = new_profile.chars().count();
    if new_len > profile::CAP {
        return Ok(json!({
            "rejected": true,
            "reason": format!("Replacement would put the profile at {new_len}/{} chars.", profile::CAP),
            "cap": profile::CAP
        }));
    }
    set_profile_field(pool, agent, PROFILE, &new_profile).await?;
    Ok(json!({ "replaced": true, "chars": new_len, "cap": profile::CAP }))
}

pub async fn context_remove(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let text = req_str(args, "text")?;
    let p = get_profile(pool, agent).await?;
    if !p.contains(&text) {
        return Err("text not found in the profile".into());
    }
    // Remove the substring, and a fact line it leaves empty.
    let new_profile = p
        .lines()
        .filter_map(|l| {
            if !l.contains(&text) {
                return Some(l.to_string());
            }
            let rest = l.replace(&text, "");
            (!matches!(rest.trim(), "-" | "")).then_some(rest)
        })
        .collect::<Vec<_>>()
        .join("\n");
    set_profile_field(pool, agent, PROFILE, &new_profile).await?;
    Ok(json!({ "removed": true, "chars": new_profile.chars().count() }))
}

pub async fn read_self(pool: &DbPool, agent: &str) -> Result<Value, String> {
    let row: Option<(String, String, String)> = sqlx::query_as(
        "SELECT display_name, instructions, user_context FROM db_agent_profiles WHERE agent = $1",
    )
    .bind(agent)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let persona: Option<(String, String, Option<String>, String)> =
        sqlx::query_as(
            "SELECT name, display_name, emoji, system_prompt FROM db_agent_personas \
             WHERE agent = $1 ORDER BY created_at LIMIT 1",
        )
        .bind(agent)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
    let (display_name, instructions, user_profile) = row.ok_or("agent profile not found")?;
    let persona_json = persona.map(|(name, pdisplay, emoji, system_prompt)| {
        json!({ "name": name, "display_name": pdisplay, "emoji": emoji, "system_prompt": system_prompt })
    });
    Ok(json!({
        "agent": agent,
        "display_name": display_name,
        "instructions": instructions,
        "profile_of_the_user": user_profile,
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

pub async fn update_persona(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let system_prompt = opt_string(args, "system_prompt");
    let display_name = opt_string(args, "display_name");
    let emoji = opt_string(args, "emoji");
    let row: Option<(String,)> = sqlx::query_as(
        "UPDATE db_agent_personas SET \
           system_prompt = COALESCE($2, system_prompt), \
           display_name = COALESCE($3, display_name), \
           emoji = COALESCE($4, emoji), \
           updated_at = NOW() \
         WHERE agent = $1 RETURNING name",
    )
    .bind(agent)
    .bind(&system_prompt)
    .bind(&display_name)
    .bind(&emoji)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((name,)) => Ok(json!({ "agent": agent, "persona": name, "updated": true })),
        None => Err("agent persona not found".into()),
    }
}

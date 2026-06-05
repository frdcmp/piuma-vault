//! Assembles a conversation's system prompt from the agent's DB rows
//! (`db_agent_profiles` + `db_agent_personas`), in the §8 order:
//! instructions → user_context → persona system_prompt → memory.

use crate::db::db::DbPool;

use super::models::{AgentProfileRow, PersonaRow};

pub struct ResolvedAgent {
    pub profile: AgentProfileRow,
    pub persona: PersonaRow,
    pub system_prompt: String,
}

pub async fn resolve(
    pool: &DbPool,
    agent: &str,
    persona_name: &str,
) -> Result<ResolvedAgent, String> {
    let profile: AgentProfileRow =
        sqlx::query_as("SELECT * FROM db_agent_profiles WHERE agent = $1")
            .bind(agent)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("agent profile '{agent}' not configured"))?;

    let persona: PersonaRow =
        sqlx::query_as("SELECT * FROM db_agent_personas WHERE agent = $1 AND name = $2")
            .bind(agent)
            .bind(persona_name)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("persona '{persona_name}' not found for agent '{agent}'"))?;

    let mut parts: Vec<String> = Vec::new();
    if !profile.instructions.trim().is_empty() {
        parts.push(profile.instructions.clone());
    }
    if !profile.user_context.trim().is_empty() {
        parts.push(format!("# User context\n\n{}", profile.user_context));
    }
    if !persona.system_prompt.trim().is_empty() {
        parts.push(persona.system_prompt.clone());
    }
    if !profile.memory.trim().is_empty() {
        parts.push(format!("# Memory\n\n{}", profile.memory));
    }
    let system_prompt = parts.join("\n\n");

    Ok(ResolvedAgent {
        profile,
        persona,
        system_prompt,
    })
}

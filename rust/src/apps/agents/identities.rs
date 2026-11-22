//! Assembles a conversation's system prompt from the agent's row in
//! `db_agent_profiles`, in the §8 order: instructions → the profile of the user
//! (L1, `profile`) → its personality.

use crate::db::db::DbPool;

use super::models::AgentProfileRow;

pub struct ResolvedAgent {
    pub profile: AgentProfileRow,
    pub system_prompt: String,
}

pub async fn resolve(pool: &DbPool, agent: &str) -> Result<ResolvedAgent, String> {
    let profile: AgentProfileRow =
        sqlx::query_as("SELECT * FROM db_agent_profiles WHERE agent = $1")
            .bind(agent)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("agent profile '{agent}' not configured"))?;

    let mut parts: Vec<String> = Vec::new();
    if !profile.instructions.trim().is_empty() {
        parts.push(profile.instructions.clone());
    }
    if !profile.user_context.trim().is_empty() {
        parts.push(format!("# About the user\n\n{}", profile.user_context));
    }
    if !profile.personality.trim().is_empty() {
        parts.push(profile.personality.clone());
    }
    let system_prompt = parts.join("\n\n");

    Ok(ResolvedAgent { profile, system_prompt })
}

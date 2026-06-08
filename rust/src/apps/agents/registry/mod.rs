//! Agent registry. The agent *kind* — its type, tool subscriptions and persona
//! name — is defined in code here; editable prose lives in `db_agent_profiles` /
//! `db_agent_personas`. Adding a native agent = one entry + its DB rows.

pub mod vault_agent;

#[derive(Debug, Clone)]
pub struct AgentDef {
    pub kind: &'static str,
    pub display_name: &'static str,
    /// Default (and, for now, only) persona name.
    pub persona: &'static str,
    /// Tool names this agent may use (a persona can narrow this further).
    pub tools: &'static [&'static str],
}

pub fn all() -> Vec<&'static AgentDef> {
    vec![&vault_agent::DEF]
}

pub fn get(kind: &str) -> Option<&'static AgentDef> {
    all().into_iter().find(|a| a.kind == kind)
}

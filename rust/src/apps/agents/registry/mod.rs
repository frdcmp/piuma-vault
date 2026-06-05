//! Agent registry. The agent *kind* — its tool subscriptions and persona name —
//! is defined in code here; the editable prose lives in `db_agent_profiles` /
//! `db_agent_personas`. Adding an agent = one entry here + its DB rows.

pub mod vault_agent;

#[derive(Debug, Clone)]
pub struct AgentDef {
    pub kind: &'static str,
    pub display_name: &'static str,
    /// Default (and, for now, only) persona name — which `db_agent_personas`
    /// row to load.
    pub persona: &'static str,
    /// Tool names this agent may use (a persona can narrow further).
    pub tools: &'static [&'static str],
}

pub fn all() -> Vec<&'static AgentDef> {
    vec![&vault_agent::DEF]
}

pub fn get(kind: &str) -> Option<&'static AgentDef> {
    all().into_iter().find(|a| a.kind == kind)
}

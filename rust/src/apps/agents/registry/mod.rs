//! Agent registry. The agent *kind* — its type and tool subscriptions — is
//! defined in code here; its editable prose (instructions, personality, the
//! profile of the user, commands) lives in `db_agent_profiles`. Adding a native
//! agent = one entry + its row.

pub mod vault_agent;

#[derive(Debug, Clone)]
pub struct AgentDef {
    pub kind: &'static str,
    pub display_name: &'static str,
    /// Tool names this agent may use.
    pub tools: &'static [&'static str],
}

pub fn all() -> Vec<&'static AgentDef> {
    vec![&vault_agent::DEF]
}

pub fn get(kind: &str) -> Option<&'static AgentDef> {
    all().into_iter().find(|a| a.kind == kind)
}

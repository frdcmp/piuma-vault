//! Agent registry. The agent *kind* — its type, tool subscriptions and persona
//! name — is defined in code here; editable prose lives in `db_agent_profiles` /
//! `db_agent_personas`. Adding a native agent = one entry + its DB rows.

pub mod openclaw;
pub mod vault_agent;

/// How an agent runs a turn.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AgentType {
    /// Runs the provider loop (DeepSeek…) with DB-backed persona + tools,
    /// persisting to `db_chat_*`.
    Native,
    /// Proxies the turn to an external chat service (e.g. OpenClaw) that owns
    /// its own model / prompt / tools. Skips the provider/persona/tool machinery.
    Gateway,
}

#[derive(Debug, Clone)]
pub struct AgentDef {
    pub kind: &'static str,
    pub display_name: &'static str,
    pub agent_type: AgentType,
    /// Default (and, for now, only) persona name — native agents only.
    pub persona: &'static str,
    /// Tool names this agent may use (native agents only; a persona can narrow).
    pub tools: &'static [&'static str],
}

pub fn all() -> Vec<&'static AgentDef> {
    vec![&vault_agent::DEF, &openclaw::DEF]
}

pub fn get(kind: &str) -> Option<&'static AgentDef> {
    all().into_iter().find(|a| a.kind == kind)
}

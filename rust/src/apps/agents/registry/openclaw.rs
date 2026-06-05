//! OpenClaw as a `gateway` agent — selectable in the same picker as the native
//! agents. The chat handler proxies its turns to the OpenClaw gateway
//! (`apps/llm/openclaw`); it has no DB persona/tools/model of its own.

use super::{AgentDef, AgentType};

pub static DEF: AgentDef = AgentDef {
    kind: "openclaw",
    display_name: "OpenClaw",
    agent_type: AgentType::Gateway,
    persona: "",
    tools: &[],
};

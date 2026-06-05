//! The vault agent — the first (and currently only) agent. Its default
//! subscription is Tier-1 read + Tier-2 create/edit + web (see plan §9).
//! Deletes / shares / self-config (Tier 3) are intentionally omitted here and
//! enabled per-persona via `db_agent_personas.allowed_tools`.

use super::{AgentDef, AgentType};

pub static DEF: AgentDef = AgentDef {
    kind: "vault_agent",
    display_name: "Vault Agent",
    agent_type: AgentType::Native,
    persona: "piuma",
    tools: &[
        // Tier 1 — read
        "search_notes",
        "read_note",
        "list_folders",
        "browse_folder",
        "search_folders",
        "list_tags",
        "list_storage",
        "signed_url",
        "get_agenda",
        "list_events",
        "get_event",
        "list_tasks",
        "get_task",
        "list_recurring",
        // Tier 2 — create/edit
        "create_note",
        "update_note",
        "append_to_note",
        "create_event",
        "update_event",
        "create_task",
        "update_task",
        "toggle_task",
        "create_recurring",
        "update_recurring",
        "complete_occurrence",
        // Web (server-side, provider-agnostic)
        "web_search",
        "web_fetch",
    ],
};

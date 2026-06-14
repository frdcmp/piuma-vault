//! The vault agent — the first (and currently only) agent. It subscribes to the
//! full catalogue: Tier-1 read + Tier-2 create/edit + Tier-3 sensitive
//! (deletes / storage writes / shares / self-config) + web (see plan §9).
//! A persona can still narrow this via `db_agent_personas.allowed_tools`.

use super::AgentDef;

pub static DEF: AgentDef = AgentDef {
    kind: "vault_agent",
    display_name: "Vault Agent",
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
        "list_buckets",
        "list_recordings",
        "get_recording",
        "start_recording",
        // Tier 2 — create/edit
        "create_bucket",
        "rename_bucket",
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
        // Tier 3 — sensitive (deletes / storage writes / shares / self-config)
        "delete_note",
        "delete_task",
        "delete_recurring",
        "delete_event",
        "delete_bucket",
        "delete_object",
        "delete_folder",
        "bulk_move",
        "presign_upload",
        "zip_bundle",
        "list_shares",
        "create_share",
        "update_share",
        "delete_share",
        "read_self",
        "update_instructions",
        "update_user_context",
        "update_memory",
        "update_persona",
        // L1 always-in-context scratchpad (capped, compactable)
        "context_add",
        "context_replace",
        "context_remove",
        "context_list",
        // L2 semantic memory (long-term, vector-searchable)
        "memory_search",
        "memory_save",
        "memory_update",
        "memory_delete",
        "memory_list",
        "memory_confirm",
        "memory_reject",
        "memory_related",
        // L3 conversation retrieval (full-text search over chat history)
        "search_conversations",
        // Web (server-side, provider-agnostic)
        "web_search",
        "web_fetch",
        // Email — send (SMTP, owner BCC'd, rate-limited + audited; mainly for
        // cron) + read (IMAP). Both no-op gracefully when unconfigured.
        "send_email",
        "read_email",
        // GitHub (token from admin → Services) — read
        "github_list_repos",
        "github_search_repos",
        "github_read_file",
        "github_list_dir",
        "github_list_commits",
        "github_list_branches",
        "github_list_issues",
        "github_list_prs",
        // GitHub — write (additive: file commit, issue, branch, PR)
        "github_create_or_update_file",
        "github_create_issue",
        "github_create_branch",
        "github_create_pull_request",
        // Navigation — agent-initiated "Go" actions (note/event/task/view/url)
        "navigate",
        // Database backup — full DB dump → S3 (non-destructive; mainly for cron)
        "backup_database",
    ],
};

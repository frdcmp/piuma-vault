//! vault: the vault itself, out only. Tasks, calendar events and notes, written through the vault
//! agent's own tools (`apps::agents::tools::vault_write`), as the user. Every task and event it makes carries
//! the tag `pigeon`; each result carries the url to open it.

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::agents::tools;
use crate::apps::pigeon::connectors::{arg_str, need_str, ActionDef, Connector, Kind};
use crate::apps::pigeon::owner;
use crate::apps::pigeon::state::State;

pub struct Vault;

pub const ID: &str = "vault";

#[async_trait]
impl Connector for Vault {
    fn id(&self) -> &'static str {
        ID
    }

    fn title(&self) -> &'static str {
        "Piuma Vault"
    }

    fn available(&self, _st: &State) -> Result<(), String> {
        Ok(())
    }

    fn actions(&self) -> Vec<ActionDef> {
        vec![
            ActionDef {
                name: "create_task",
                kind: Kind::Record,
                description: "Create a task in the user's vault: something they must do or remember.",
                params: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string", "description": "Short and concrete: what to do" },
                        "due": { "type": "string", "description": "When it's due, ISO 8601 (a date, or a date and time with offset)" },
                        "priority": { "type": "string", "enum": ["none", "low", "medium", "high"] },
                        "notes": { "type": "string", "description": "Context: who asked, what exactly, links" },
                    },
                    "required": ["title"],
                }),
                on_conversation: false,
                agent: true,
            },
            ActionDef {
                name: "create_event",
                kind: Kind::Record,
                description: "Create a calendar event in the user's vault: an agreed meeting, call or appointment.",
                params: json!({
                    "type": "object",
                    "properties": {
                        "title": { "type": "string" },
                        "start": { "type": "string", "description": "ISO 8601 date and time with offset, or a date for an all-day event" },
                        "end": { "type": "string", "description": "ISO 8601, optional" },
                        "all_day": { "type": "boolean" },
                        "location": { "type": "string" },
                        "description": { "type": "string" },
                    },
                    "required": ["title", "start"],
                }),
                on_conversation: false,
                agent: true,
            },
            ActionDef {
                name: "append_note",
                kind: Kind::Record,
                description: "Add text at the end of an existing note in the user's vault (by its id).",
                params: json!({
                    "type": "object",
                    "properties": {
                        "note_id": { "type": "string", "description": "The note's UUID" },
                        "text": { "type": "string", "description": "Markdown to add" },
                    },
                    "required": ["note_id", "text"],
                }),
                on_conversation: false,
                agent: true,
            },
            ActionDef {
                name: "log",
                kind: Kind::Record,
                description: "Add a line (or a few) to a running note found by its folder and title, made when it doesn't exist yet: a monthly ledger, a log. For rules (a bank alert, a receipt); the agent is never offered it.",
                params: json!({
                    "type": "object",
                    "properties": {
                        "folder": { "type": "string", "description": "The note's folder, from the root: /finance/bank" },
                        "title": { "type": "string", "description": "The note's exact title: Bank 2026-11" },
                        "text": { "type": "string", "description": "Markdown to add at the end" },
                    },
                    "required": ["folder", "title", "text"],
                }),
                on_conversation: false,
                agent: false,
            },
        ]
    }

    async fn run(&self, st: &State, user: &str, action: &str, args: &Json, _conversation: Option<Uuid>) -> anyhow::Result<Json> {
        let tz = owner::get(&st.pool, user).await.tz;
        match action {
            "create_task" => {
                let mut a = json!({ "title": need_str(args, "title")?, "tags": ["pigeon"] });
                if let Some(n) = arg_str(args, "notes") {
                    a["notes"] = json!(n);
                }
                if let Some(d) = arg_str(args, "due") {
                    a["due_at"] = json!(when(d, tz, true)?.to_rfc3339());
                }
                if let Some(p) = arg_str(args, "priority") {
                    a["priority"] = json!(match p {
                        "low" => 1,
                        "medium" => 2,
                        "high" => 3,
                        _ => 0,
                    });
                }
                let t = tool(st, user, "create_task", &a).await?;
                Ok(json!({ "task_id": t["id"], "title": t["title"], "due_at": a.get("due_at"), "url": link(st, "tasks?task=", &t["id"]) }))
            }
            "create_event" => {
                let all_day = args.get("all_day").and_then(Json::as_bool).unwrap_or(false);
                let start = need_str(args, "start")?;
                let mut a = json!({
                    "title": need_str(args, "title")?,
                    "starts_at": when(start, tz, false)?.to_rfc3339(),
                    "all_day": all_day || start.len() == 10,
                    "tags": ["pigeon"],
                });
                if let Some(e) = arg_str(args, "end") {
                    a["ends_at"] = json!(when(e, tz, false)?.to_rfc3339());
                }
                for f in ["location", "description"] {
                    if let Some(v) = arg_str(args, f) {
                        a[f] = json!(v);
                    }
                }
                let e = tool(st, user, "create_event", &a).await?;
                Ok(json!({ "event_id": e["id"], "title": a["title"], "starts_at": a["starts_at"], "url": link(st, "calendar?event=", &e["id"]) }))
            }
            "append_note" => {
                let id = need_str(args, "note_id")?;
                Uuid::parse_str(id).map_err(|_| anyhow::anyhow!("note_id is not a UUID"))?;
                let n = tool(st, user, "append_to_note", &json!({ "id": id, "text": need_str(args, "text")? })).await?;
                Ok(json!({ "note_id": id, "title": n.get("title"), "url": link(st, "notes/", &json!(id)) }))
            }
            "log" => {
                let folder = need_str(args, "folder")?.trim_end_matches('/');
                let folder = if folder.is_empty() { "/" } else { folder };
                if !folder.starts_with('/') {
                    anyhow::bail!("folder must start with /");
                }
                let title = need_str(args, "title")?;
                let text = need_str(args, "text")?;
                let found: Option<Uuid> = sqlx::query_scalar(
                    "SELECT id FROM notes WHERE user_id = $1 AND title = $2 AND rtrim(folder, '/') = rtrim($3, '/') AND deleted_at IS NULL
                      ORDER BY updated_at DESC LIMIT 1",
                )
                .bind(user)
                .bind(title)
                .bind(folder)
                .fetch_optional(&st.pool)
                .await?;
                match found {
                    Some(id) => {
                        tool(st, user, "append_to_note", &json!({ "id": id, "text": text })).await?;
                        Ok(json!({ "note_id": id, "title": title, "made": false, "url": link(st, "notes/", &json!(id)) }))
                    }
                    None => {
                        let n = tool(st, user, "create_note", &json!({ "title": title, "folder": folder, "content": text, "tags": ["pigeon"] })).await?;
                        Ok(json!({ "note_id": n["id"], "title": title, "made": true, "url": link(st, "notes/", &n["id"]) }))
                    }
                }
            }
            other => anyhow::bail!("vault has no action '{other}'"),
        }
    }

    async fn health(&self, _st: &State, _user: &str) -> Json {
        json!({ "available": true, "ok": true })
    }
}

async fn tool(st: &State, user: &str, name: &str, args: &Json) -> anyhow::Result<Json> {
    tools::vault_write(&st.pool, user, name, args).await.map_err(|e| anyhow::anyhow!("{e}"))
}

/// Where the user opens it in the vault's web app: a task (`tasks?task=`), an event
/// (`calendar?event=`), a note (`notes/`).
fn link(st: &State, page: &str, id: &Json) -> Option<String> {
    Some(format!("{}/{page}{}", st.cfg.public_url, id.as_str()?))
}

/// An ISO 8601 date or date-time; without an offset it's the user's time. A bare date is the end
/// of that day for a due date, its start for an event.
pub fn when(s: &str, tz: Tz, end_of_day: bool) -> anyhow::Result<DateTime<Utc>> {
    let s = s.trim();
    if let Ok(d) = DateTime::parse_from_rfc3339(s) {
        return Ok(d.with_timezone(&Utc));
    }
    for f in ["%Y-%m-%dT%H:%M:%S", "%Y-%m-%dT%H:%M", "%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M"] {
        if let Ok(n) = NaiveDateTime::parse_from_str(s, f) {
            return local(n, tz);
        }
    }
    if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
        let t = if end_of_day { d.and_hms_opt(23, 59, 0) } else { d.and_hms_opt(0, 0, 0) };
        return local(t.expect("a valid time"), tz);
    }
    anyhow::bail!("'{s}' is not an ISO 8601 date or date and time")
}

fn local(n: NaiveDateTime, tz: Tz) -> anyhow::Result<DateTime<Utc>> {
    tz.from_local_datetime(&n).single().map(|d| d.with_timezone(&Utc)).ok_or_else(|| anyhow::anyhow!("an impossible local time"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dates_in_the_users_time() {
        let tz: Tz = "Asia/Bangkok".parse().unwrap();
        assert_eq!(when("2026-11-07T18:00:00+07:00", tz, false).unwrap().to_rfc3339(), "2026-11-07T11:00:00+00:00");
        assert_eq!(when("2026-11-07T18:00", tz, false).unwrap().to_rfc3339(), "2026-11-07T11:00:00+00:00");
        assert_eq!(when("2026-11-07", tz, true).unwrap().to_rfc3339(), "2026-11-07T16:59:00+00:00");
        assert_eq!(when("2026-11-07", tz, false).unwrap().to_rfc3339(), "2026-11-06T17:00:00+00:00");
        assert!(when("next friday", tz, false).is_err());
    }
}

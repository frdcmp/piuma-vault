//! The vault over MCP (`POST /mcp`, behind nginx `/api/v1/mcp`), for an assistant that speaks the
//! Model Context Protocol (Claude, a desktop client), with a vault API key (`x-api-key`) or a
//! sign-in: Pigeon's tools (`tools`, the Inbox, and `mcp_files`, its files) and the vault's notes,
//! tasks, recurring tasks, buckets, calendar, agenda and recorder (`agents::tools::vault_mcp`).
//!
//! The Inbox's tools are the ones Piuma has, under the same two rules: a message goes only in
//! words the user has seen, and a big change waits for their tap in the Inbox (`confirm`). A key
//! sees and runs only what its scopes allow: for the Inbox `tools::scope` (`inbox.read` reads,
//! `inbox.write` acts, `inbox.access` decides who may be told what), for the rest
//! `vault_mcp::scopes` (the notes, tasks, calendar and recorder scopes the REST API checks). Here, and only
//! here, a person signed in through the suite's gateway comes in too, with its access token (`oauth`).
//!
//! Streamable HTTP, stateless: each POST is one JSON-RPC message (or a batch) answered as JSON;
//! there's no stream to open (GET is 405) and no session to keep. A tool's result is text (its
//! JSON), but for `pigeon_file`, whose image is an `image` block.

use std::future::Future;
use std::pin::Pin;

use actix_web::{dev::Payload, web, FromRequest, HttpRequest, HttpResponse};
use serde_json::{json, Value as Json};

use crate::apps::agents::tools::vault_mcp;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::pigeon::state::AppState;
use crate::apps::pigeon::{mcp_files, oauth, tools};

/// The protocol versions answered as asked, newest first; anything else gets the newest.
const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "The user's vault: notes, tasks, the calendar, recordings, and their Inbox. Notes: notes_search first (the vault likely \
has a note on it already: add to it rather than make another), notes_get before changing one; notes_update's content replaces the whole \
body, notes_append adds, notes_replace_text changes one passage; notes_delete only moves a note to the trash (notes_restore). What's on: \
agenda (tasks due, events, recurring occurrences), then tasks_list (overdue: true for what's late), recurring_list, calendar_list and \
buckets_list, each area with its get, create, update and delete tools. Times are UTC; give them in RFC 3339 with an offset. An update \
changes only what it's given; it clears a field only when told (clear_due, clear_end, clear_until, bucket \"none\"). A bucket is named \
from buckets_list: an unknown name is an error, and buckets_create makes a new one. tasks_delete, recurring_delete, calendar_delete and \
buckets_delete are permanent: ask the user first.

Recordings (meetings, calls, voice notes, made in the web app or the phone): recorder_sessions, newest first; each one's summary \
is a note (final_note_id); what was said is recorder_transcript, paged by next_offset. recorder_summarise writes the summary note \
again; recorder_append and recorder_delete are permanent: ask the user first.

Pigeon is the user's Inbox: their WhatsApp, Instagram and Gmail in one place, with an agent that sorts what \
comes in and answers where they let it. Start with pigeon_inbox (what needs them) or pigeon_pending (what waits for their yes). A message \
to someone goes only in words the user has seen: draft it (pigeon_draft_reply), show them the full text, send on their word. A message's \
photo or document is pigeon_file (what it can't show, a PDF or an Office file, it gives at a download_url to fetch); a file to attach to an email is stored with pigeon_upload, its `file` then passed in `files`. Who may \
be told what (the user's place, their calendar, a note of theirs) is read with pigeon_access and pigeon_permissions; with a vault key \
that holds inbox.access it is changed with pigeon_grant, pigeon_revoke and pigeon_set_group (not there without one). Grant only what the \
user asked, for whom they said; never let Pigeon answer on its own (mode auto, a policy to auto) unless they ask, and then it still \
waits for their tap in the Inbox.";

/// Who calls: a vault key or sign-in, as everywhere in the vault, or a person signed in through
/// the suite (`oauth`); and the assistant to mark what it sends as its (none: the user's own sign-in).
pub struct Caller {
    user: AuthenticatedUser,
    by: Option<String>,
}

impl FromRequest for Caller {
    type Error = actix_web::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self, Self::Error>>>>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        let ours = req.app_data::<web::Data<AppState>>().and_then(|st| {
            let conf = st.cfg.mcp_auth.clone()?;
            let token = oauth::ours(req, &conf)?;
            Some((st.clone(), conf, token))
        });
        if let Some((st, conf, token)) = ours {
            return Box::pin(async move {
                match oauth::caller(&st.pool, &conf, &token).await {
                    Ok((user, by)) => Ok(Caller { user, by: Some(by) }),
                    Err(refused) => Err(refused.into_error(&conf)),
                }
            });
        }
        let user = AuthenticatedUser::from_request(req, payload);
        Box::pin(async move {
            let user = user.await?;
            Ok(Caller { by: super::handlers::assistant(&user), user })
        })
    }
}

fn result(id: &Json, result: Json) -> Json {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Json, code: i64, message: &str) -> Json {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The scopes that let a caller run a tool, any one of them; none: no such tool.
fn need(name: &str) -> Option<Vec<&'static str>> {
    if tools::names().contains(&name) {
        Some(vec![tools::scope(name)])
    } else if let Some(scope) = mcp_files::scope(name) {
        Some(vec![scope])
    } else {
        vault_mcp::scopes(name).map(<[_]>::to_vec)
    }
}

fn may(user: &AuthenticatedUser, scopes: &[&str]) -> bool {
    scopes.iter().any(|s| check_permission(user, s))
}

/// The tools this key may run, as MCP lists them: the vault's, then the Inbox's and its files.
fn listed(user: &AuthenticatedUser) -> Vec<Json> {
    let vault = vault_mcp::defs().into_iter().filter(|t| may(user, t.scopes())).map(|t| {
        json!({
            "name": t.name, "description": t.description, "inputSchema": t.schema,
            "annotations": { "readOnlyHint": t.read_only(), "destructiveHint": t.destructive() },
        })
    });
    let inbox = tools::defs()
        .into_iter()
        .filter(|(name, _, _)| check_permission(user, tools::scope(name)))
        .map(|(name, description, schema)| {
            json!({
                "name": name, "description": description, "inputSchema": schema,
                "annotations": { "readOnlyHint": tools::scope(name) == "inbox.read" },
            })
        });
    let files = mcp_files::defs().into_iter().filter(|(name, _, _)| need(name).is_some_and(|n| may(user, &n))).map(|(name, description, schema)| {
        let read_only = mcp_files::scope(name) == Some("inbox.read");
        json!({
            "name": name, "description": description, "inputSchema": schema,
            "annotations": { "readOnlyHint": read_only, "destructiveHint": false },
        })
    });
    vault.chain(inbox).chain(files).collect()
}

/// Who answers: the name a client and the suite's gateway know this server by.
fn server_info() -> Json {
    json!({ "name": "pigeon", "title": "Pigeon (the Inbox)", "version": env!("CARGO_PKG_VERSION") })
}

fn text(t: String) -> Json {
    json!({ "type": "text", "text": t })
}

/// One message; none: a notification (nothing to answer).
async fn handle(req: &HttpRequest, st: &AppState, caller: &Caller, msg: &Json) -> Option<Json> {
    let user = &caller.user;
    let id = msg.get("id").filter(|i| !i.is_null())?;
    let method = msg.get("method").and_then(Json::as_str).unwrap_or_default();
    let params = msg.get("params").cloned().unwrap_or_else(|| json!({}));
    Some(match method {
        "initialize" => {
            let asked = params.get("protocolVersion").and_then(Json::as_str).unwrap_or_default();
            let version = VERSIONS.iter().find(|v| **v == asked).unwrap_or(&VERSIONS[0]);
            result(
                id,
                json!({
                    "protocolVersion": version,
                    "capabilities": { "tools": { "listChanged": false } },
                    "serverInfo": server_info(),
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": listed(user) })),
        "tools/call" => {
            let name = params.get("name").and_then(Json::as_str).unwrap_or_default();
            let Some(need) = need(name) else {
                return Some(error(id, -32602, &format!("no tool {name}")));
            };
            if !may(user, &need) {
                let text = format!("This key can't: it needs the {} scope.", need.join(" or "));
                return Some(result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": true })));
            }
            let args = params.get("arguments").cloned().filter(Json::is_object).unwrap_or_else(|| json!({}));
            // what a tool gives back: its JSON as text, or (a file) its own content blocks
            let ran = if mcp_files::scope(name).is_some() {
                mcp_files::call(st, &user.user_id, name, &args).await
            } else {
                let v = if tools::names().contains(&name) {
                    tools::call_as(st, &user.user_id, name, &args, caller.by.clone().unwrap_or_else(|| "an assistant".into())).await
                } else {
                    vault_mcp::call(req, user, name, &args).await
                };
                v.map(|v| vec![text(serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()))])
            };
            let (content, failed) = match ran {
                Ok(blocks) => (blocks, false),
                Err(e) => (vec![text(e)], true),
            };
            result(id, json!({ "content": content, "isError": failed }))
        }
        // nothing else is offered (no resources, no prompts)
        "resources/list" => result(id, json!({ "resources": [] })),
        "resources/templates/list" => result(id, json!({ "resourceTemplates": [] })),
        "prompts/list" => result(id, json!({ "prompts": [] })),
        other => error(id, -32601, &format!("no method {other}")),
    })
}

pub async fn post(req: HttpRequest, st: web::Data<AppState>, caller: Caller, body: web::Json<Json>) -> HttpResponse {
    let body = body.into_inner();
    match &body {
        Json::Array(msgs) => {
            let mut out = Vec::new();
            for m in msgs {
                out.extend(handle(&req, &st, &caller, m).await);
            }
            if out.is_empty() {
                HttpResponse::Accepted().finish()
            } else {
                HttpResponse::Ok().json(out)
            }
        }
        msg => match handle(&req, &st, &caller, msg).await {
            Some(answer) => HttpResponse::Ok().json(answer),
            None => HttpResponse::Accepted().finish(),
        },
    }
}

/// No stream to listen on, no session to end.
pub async fn no_stream() -> HttpResponse {
    HttpResponse::MethodNotAllowed().insert_header(("Allow", "POST")).finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn key(scopes: &[&str]) -> AuthenticatedUser {
        AuthenticatedUser {
            user_id: "u".into(),
            email: "someone@example.com".into(),
            first_name: None,
            last_name: None,
            permissions: scopes.iter().map(|s| s.to_string()).collect(),
            groups: vec![],
            via_api_key: true,
        }
    }

    fn names(user: &AuthenticatedUser) -> Vec<String> {
        listed(user).iter().map(|t| t["name"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn a_key_sees_what_its_scopes_allow() {
        let notes_reader = names(&key(&["notes.read"]));
        assert!(notes_reader.contains(&"notes_search".into()));
        assert!(notes_reader.contains(&"notes_trash".into()));
        assert!(!notes_reader.contains(&"notes_create".into()));
        assert!(!notes_reader.iter().any(|n| n.starts_with("tasks_") || n.starts_with("pigeon_") || n == "agenda"));

        let calendar = names(&key(&["calendar.manage"]));
        assert!(calendar.contains(&"calendar_delete".into()));
        assert!(calendar.contains(&"buckets_create".into()));
        assert!(calendar.contains(&"agenda".into()));
        assert!(!calendar.iter().any(|n| n.starts_with("tasks_") || n.starts_with("recurring_")));

        let inbox = names(&key(&["inbox.read"]));
        assert!(inbox.contains(&"pigeon_inbox".into()));
        assert!(inbox.contains(&"pigeon_file".into()));
        assert!(!inbox.contains(&"pigeon_upload".into()));
        let writer = names(&key(&["inbox.write"]));
        assert!(writer.contains(&"pigeon_upload".into()));
        assert!(!writer.contains(&"pigeon_file".into()));
        assert!(!inbox.iter().any(|n| !n.starts_with("pigeon_")));

        assert!(names(&key(&[])).is_empty());
        let all = names(&key(&["admin_access"]));
        assert_eq!(all.len(), vault_mcp::defs().len() + tools::names().len() + mcp_files::names().len());
    }

    #[test]
    fn no_name_twice_across_both() {
        let all = names(&key(&["admin_access"]));
        let unique: std::collections::HashSet<_> = all.iter().collect();
        assert_eq!(unique.len(), all.len());
    }

    #[test]
    fn hints_as_the_tools_are() {
        let all = listed(&key(&["admin_access"]));
        let hints = |n: &str| all.iter().find(|t| t["name"] == n).unwrap()["annotations"].clone();
        assert_eq!(hints("notes_get"), json!({ "readOnlyHint": true, "destructiveHint": false }));
        assert_eq!(hints("notes_delete"), json!({ "readOnlyHint": false, "destructiveHint": false }));
        assert_eq!(hints("calendar_delete"), json!({ "readOnlyHint": false, "destructiveHint": true }));
        assert_eq!(hints("pigeon_file"), json!({ "readOnlyHint": true, "destructiveHint": false }));
        assert_eq!(hints("pigeon_upload"), json!({ "readOnlyHint": false, "destructiveHint": false }));
    }

    #[test]
    fn the_scope_a_call_needs() {
        assert_eq!(need("pigeon_grant"), Some(vec!["inbox.access"]));
        assert_eq!(need("tasks_create"), Some(vec!["tasks.write", "tasks.manage"]));
        assert_eq!(need("nothing"), None);
        assert_eq!(need("pigeon_file"), Some(vec!["inbox.read"]));
        assert_eq!(need("pigeon_upload"), Some(vec!["inbox.write"]));
        assert!(!may(&key(&["inbox.read"]), &need("pigeon_upload").unwrap()));
        assert!(may(&key(&["tasks.manage"]), &need("tasks_create").unwrap()));
        assert!(!may(&key(&["tasks.read"]), &need("tasks_create").unwrap()));
    }

    #[test]
    fn the_instructions_name_tools_exactly() {
        // the suite's gateway prefixes each exact tool name in this text: a wildcard it can't
        assert!(!INSTRUCTIONS.contains("_*"), "a wildcard in the instructions");
        let all = names(&key(&["admin_access"]));
        let areas = ["notes_", "tasks_", "recurring_", "calendar_", "buckets_", "recorder_", "pigeon_"];
        let words = INSTRUCTIONS.split(|c: char| !(c.is_ascii_lowercase() || c == '_')).filter(|w| areas.iter().any(|a| w.starts_with(a)));
        for w in words {
            assert!(all.iter().any(|n| n == w), "{w} isn't a tool");
        }
        for named in ["pigeon_file", "pigeon_upload", "pigeon_grant", "pigeon_revoke", "tasks_list", "agenda"] {
            assert!(INSTRUCTIONS.contains(named), "{named}");
        }
        assert!(INSTRUCTIONS.contains("inbox.access"));
    }

    #[test]
    fn the_server_is_pigeon() {
        assert_eq!(server_info()["name"], "pigeon");
        assert_eq!(server_info()["title"], "Pigeon (the Inbox)");
    }
}

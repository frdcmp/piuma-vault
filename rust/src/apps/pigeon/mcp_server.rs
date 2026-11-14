//! The Inbox over MCP (`POST /mcp`, behind nginx `/api/v1/mcp`): Pigeon's tools (`tools`) for an
//! assistant that speaks the Model Context Protocol (Claude, a desktop client), with a vault API
//! key (`x-api-key`) or a sign-in. The same tools Piuma has, under the same two rules: a message
//! goes only in words the user has seen, and a big change waits for their tap in the Inbox
//! (`confirm`). A key sees and runs only what its scopes allow (`tools::scope`): `inbox.read`
//! reads, `inbox.write` acts, `inbox.access` decides who may be told what.
//!
//! Streamable HTTP, stateless: each POST is one JSON-RPC message (or a batch) answered as JSON;
//! there's no stream to open (GET is 405) and no session to keep.

use actix_web::{web, HttpResponse};
use serde_json::{json, Value as Json};

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::pigeon::state::AppState;
use crate::apps::pigeon::tools;

/// The protocol versions answered as asked, newest first; anything else gets the newest.
const VERSIONS: &[&str] = &["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS: &str = "Pigeon is the user's Inbox: their WhatsApp, Instagram and Gmail in one place, with an agent that sorts what \
comes in and answers where they let it. Start with pigeon_inbox (what needs them) or pigeon_pending (what waits for their yes). A message \
to someone goes only in words the user has seen: draft it (pigeon_draft_reply), show them the full text, send on their word. Who may be \
told what (the user's place, their calendar) is pigeon_access, pigeon_permissions, pigeon_grant, pigeon_revoke and the groups: grant only \
what the user asked, for whom they said; never let Pigeon answer on its own (mode auto, a policy to auto) unless they ask, and then it \
still waits for their tap in the Inbox.";

fn result(id: &Json, result: Json) -> Json {
    json!({ "jsonrpc": "2.0", "id": id, "result": result })
}

fn error(id: &Json, code: i64, message: &str) -> Json {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// The tools this key may run, as MCP lists them.
fn listed(user: &AuthenticatedUser) -> Vec<Json> {
    tools::defs()
        .into_iter()
        .filter(|(name, _, _)| check_permission(user, tools::scope(name)))
        .map(|(name, description, schema)| {
            json!({
                "name": name, "description": description, "inputSchema": schema,
                "annotations": { "readOnlyHint": tools::scope(name) == "inbox.read" },
            })
        })
        .collect()
}

/// One message; none: a notification (nothing to answer).
async fn handle(st: &AppState, user: &AuthenticatedUser, msg: &Json) -> Option<Json> {
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
                    "serverInfo": { "name": "pigeon", "title": "Pigeon (the Inbox)", "version": env!("CARGO_PKG_VERSION") },
                    "instructions": INSTRUCTIONS,
                }),
            )
        }
        "ping" => result(id, json!({})),
        "tools/list" => result(id, json!({ "tools": listed(user) })),
        "tools/call" => {
            let name = params.get("name").and_then(Json::as_str).unwrap_or_default();
            if !tools::names().contains(&name) {
                return Some(error(id, -32602, &format!("no tool {name}")));
            }
            let need = tools::scope(name);
            if !check_permission(user, need) {
                return Some(result(id, json!({ "content": [{ "type": "text", "text": format!("This key can't: it needs the {need} scope.") }], "isError": true })));
            }
            let args = params.get("arguments").cloned().filter(Json::is_object).unwrap_or_else(|| json!({}));
            let (text, failed) = match tools::call_as(st, &user.user_id, name, &args, super::handlers::assistant(user).unwrap_or_else(|| "an assistant".into())).await {
                Ok(v) => (serde_json::to_string_pretty(&v).unwrap_or_else(|_| v.to_string()), false),
                Err(e) => (e, true),
            };
            result(id, json!({ "content": [{ "type": "text", "text": text }], "isError": failed }))
        }
        // nothing else is offered (no resources, no prompts)
        "resources/list" => result(id, json!({ "resources": [] })),
        "resources/templates/list" => result(id, json!({ "resourceTemplates": [] })),
        "prompts/list" => result(id, json!({ "prompts": [] })),
        other => error(id, -32601, &format!("no method {other}")),
    })
}

pub async fn post(st: web::Data<AppState>, user: AuthenticatedUser, body: web::Json<Json>) -> HttpResponse {
    let body = body.into_inner();
    match &body {
        Json::Array(msgs) => {
            let mut out = Vec::new();
            for m in msgs {
                out.extend(handle(&st, &user, m).await);
            }
            if out.is_empty() {
                HttpResponse::Accepted().finish()
            } else {
                HttpResponse::Ok().json(out)
            }
        }
        msg => match handle(&st, &user, msg).await {
            Some(answer) => HttpResponse::Ok().json(answer),
            None => HttpResponse::Accepted().finish(),
        },
    }
}

/// No stream to listen on, no session to end.
pub async fn no_stream() -> HttpResponse {
    HttpResponse::MethodNotAllowed().insert_header(("Allow", "POST")).finish()
}

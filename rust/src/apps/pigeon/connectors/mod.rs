//! Connectors: everything Pigeon takes in or does goes through one. A connector is a folder here
//! implementing `Connector`:
//!
//!   in       it turns what its source delivers (a webhook, a poll) into items, through
//!            `items::ingest`, from its own background task (`start`, in the pigeon-worker) or
//!            routes (webhooks, in the backend)
//!   actions  its tools (`actions` + `run`): name, kind, JSON schema, description. The same
//!            definitions serve Pigeon's agent and Piuma (as LLM tools)
//!   connect  an account by a one-time link (`connect_start` → the provider's consent screen →
//!            `connect_finish`), or a code shown in the Inbox's settings (`connect_pairing`)
//!   webhook  what a provider pushes (`/pigeon/webhooks/{connector}`: `webhook_verify`, `webhook`)
//!
//! The rest of Pigeon never names a connector: adding one is a folder and a line in `all()`.

pub mod console;
pub mod gmail;
pub mod instagram;
pub mod vault;
pub mod whatsapp;

use std::collections::HashMap;
use std::sync::Arc;

use async_trait::async_trait;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::state::{AppState, State};

/// What an action's policy goes by.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    /// sends something to someone (a reply): never auto unless the user set it
    Reply,
    /// writes into the user's own tools (a vault task, an event, a note)
    Record,
    /// tidies a channel (archive, mark read, label)
    Organize,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Reply => "reply",
            Kind::Record => "record",
            Kind::Organize => "organize",
        }
    }

    pub fn parse(s: &str) -> Option<Kind> {
        match s {
            "reply" => Some(Kind::Reply),
            "record" => Some(Kind::Record),
            "organize" => Some(Kind::Organize),
            _ => None,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ActionDef {
    pub name: &'static str,
    pub kind: Kind,
    pub description: &'static str,
    /// JSON schema of its arguments (an object), without conversation_id or reason: those are added
    /// where they apply.
    pub params: Json,
    /// Runs on a conversation of this connector (a reply, an archive): it needs conversation_id.
    pub on_conversation: bool,
    /// Offered to the agent as a tool. False for what only the user or their rules may do (a new
    /// email to anyone, trash, a ledger line).
    pub agent: bool,
}

/// Where a pairing shown in the vault is.
pub enum Pairing {
    /// a QR code to scan (PNG, base64), and how
    Code { png_base64: String, how: String },
    /// the code is being made
    Waiting,
    /// done: the account
    Connected(String),
}

#[async_trait]
pub trait Connector: Send + Sync {
    fn id(&self) -> &'static str;
    fn title(&self) -> &'static str;
    /// Configured in this deployment, or why not.
    fn available(&self, st: &State) -> Result<(), String>;
    fn actions(&self) -> Vec<ActionDef>;
    /// Do one of its actions, as `user`. `conversation` is set for an `on_conversation` action.
    async fn run(&self, st: &State, user: &str, action: &str, args: &Json, conversation: Option<Uuid>) -> anyhow::Result<Json>;
    /// Whether the other person sees "typing…" here (`typing`): an auto reply then goes out paced
    /// like a person's (core::pace).
    fn shows_typing(&self) -> bool {
        false
    }
    /// Show (or stop showing) the other person that the user is typing in this conversation, on
    /// channels that have it: before an auto reply goes out.
    async fn typing(&self, _st: &State, _conversation: Uuid, _on: bool) -> anyhow::Result<()> {
        Ok(())
    }
    /// Background work (polling a mailbox), started once in the pigeon-worker when available.
    fn start(&self, _st: AppState) {}
    /// Its accounts and how they're doing.
    async fn health(&self, st: &State, user: &str) -> Json;
    /// Whether an account is connected by a one-time link (OAuth), not by env settings.
    fn connects_by_link(&self) -> bool {
        false
    }
    /// The one-time link was opened: where to send the browser (the provider's consent screen),
    /// carrying `token` through as OAuth's state (it names the user).
    async fn connect_start(&self, _st: &State, _token: &str) -> anyhow::Result<String> {
        anyhow::bail!("{} is connected by its settings, not a link", self.id())
    }
    /// Bring past conversations in as history (stored, never triaged or answered), so Pigeon can
    /// learn about people: with `handle`, that person's from the last `days`; without, the ones
    /// the user wrote in. At most `max_threads` threads. Returns the messages new to Pigeon.
    async fn gather(&self, _st: &State, _user: &str, _handle: Option<&str>, _days: i64, _max_threads: usize) -> anyhow::Result<usize> {
        Ok(0)
    }
    /// The provider sent the browser back: store the account for `user`; returns its name.
    async fn connect_finish(&self, _st: &State, _user: &str, _query: &HashMap<String, String>) -> anyhow::Result<String> {
        anyhow::bail!("{} is connected by its settings, not a link", self.id())
    }
    /// Whether an account is paired with a code shown in the vault (`connect_pairing`).
    fn connects_by_pairing(&self) -> bool {
        false
    }
    /// Paired in the vault (a QR code scanned with the phone, WhatsApp), not at a provider's
    /// consent screen: what the vault shows now, for `user`.
    async fn connect_pairing(&self, _st: &State, _user: &str) -> anyhow::Result<Pairing> {
        anyhow::bail!("{} isn't paired with a code", self.id())
    }
    /// The user disconnects an account: end the session where the provider has one (WhatsApp's
    /// linked device).
    async fn disconnect(&self, _st: &State, _user: &str, _account: &str) -> anyhow::Result<()> {
        Ok(())
    }
    /// A provider checking the webhook (GET): the answer to echo back, or None to refuse.
    fn webhook_verify(&self, _st: &State, _query: &HashMap<String, String>) -> Option<String> {
        None
    }
    /// A provider's push (POST): `signature` is its signature header, `body` the raw bytes. False
    /// when the signature is wrong (refused); what's in it is taken in from a background task.
    async fn webhook(&self, _st: &AppState, _signature: Option<&str>, _body: &[u8]) -> anyhow::Result<bool> {
        Ok(false)
    }
}

/// Every connector Pigeon knows, available or not.
pub fn all() -> Vec<Arc<dyn Connector>> {
    vec![Arc::new(console::Console), Arc::new(gmail::Gmail), Arc::new(instagram::Instagram), Arc::new(vault::Vault), Arc::new(whatsapp::Whatsapp)]
}

pub fn find(st: &State, id: &str) -> Option<Arc<dyn Connector>> {
    st.connectors.iter().find(|c| c.id() == id).cloned()
}

/// The actions of every available connector.
pub fn available_actions(st: &State) -> Vec<(Arc<dyn Connector>, ActionDef)> {
    st.connectors
        .iter()
        .filter(|c| c.available(st).is_ok())
        .flat_map(|c| c.actions().into_iter().map(move |a| (c.clone(), a)))
        .collect()
}

/// `<connector>_<action>`: an action's name as a tool (LLM and MCP tool names can't hold a dot).
pub fn tool_name(connector: &str, action: &str) -> String {
    format!("{connector}_{action}")
}

/// An action by its tool name.
pub fn by_tool_name(st: &State, name: &str) -> Option<(Arc<dyn Connector>, ActionDef)> {
    available_actions(st).into_iter().find(|(c, a)| tool_name(c.id(), a.name) == name)
}

/// An action's schema as a tool: its params, plus conversation_id when it runs on one, plus
/// `extra` properties (the agent's `reason`), all required where marked.
pub fn tool_schema(def: &ActionDef, with_conversation: bool, extra: &[(&str, &str)]) -> Json {
    let mut props = def.params.get("properties").and_then(Json::as_object).cloned().unwrap_or_default();
    let mut required: Vec<Json> = def.params.get("required").and_then(Json::as_array).cloned().unwrap_or_default();
    if def.on_conversation && with_conversation {
        props.insert(
            "conversation_id".into(),
            json!({ "type": "string", "description": "The conversation (its id from pigeon_inbox or pigeon_conversation)" }),
        );
        required.push(json!("conversation_id"));
    }
    for (name, desc) in extra {
        props.insert(name.to_string(), json!({ "type": "string", "description": desc }));
        required.push(json!(name));
    }
    json!({ "type": "object", "properties": props, "required": required })
}

/// A string argument, trimmed and non-empty.
pub fn arg_str<'a>(args: &'a Json, name: &str) -> Option<&'a str> {
    args.get(name).and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty())
}

pub fn need_str<'a>(args: &'a Json, name: &str) -> anyhow::Result<&'a str> {
    arg_str(args, name).ok_or_else(|| anyhow::anyhow!("`{name}` is required"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tool_schema_gets_conversation_and_reason() {
        let def = ActionDef {
            name: "send_reply",
            kind: Kind::Reply,
            description: "",
            params: json!({ "type": "object", "properties": { "text": { "type": "string" } }, "required": ["text"] }),
            on_conversation: true,
            agent: true,
        };
        let s = tool_schema(&def, true, &[("reason", "why")]);
        assert!(s["properties"]["conversation_id"].is_object());
        assert!(s["properties"]["reason"].is_object());
        assert_eq!(s["required"], json!(["text", "conversation_id", "reason"]));
        let s = tool_schema(&def, false, &[]);
        assert!(s["properties"].get("conversation_id").is_none());
        assert_eq!(tool_name("gmail", "send_reply"), "gmail_send_reply");
    }
}

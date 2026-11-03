//! whatsapp: the user's own WhatsApp (their personal account, groups too), through
//! pigeon-whatsapp (`whatsapp-bridge/` at the repo root): a server holding each user's account as
//! a linked device, like WhatsApp Web (whatsmeow), one session per vault user (`/u/{user}/…`).
//! Unofficial: WhatsApp's terms don't allow it, and the number can be banned; Pigeon keeps to
//! replies, never writes first.
//!
//! In: the server posts every message a session sees to `/pigeon/webhooks/whatsapp`, signed with
//! the shared secret and tagged with the user: theirs as items to triage, the user's own from the
//! phone as theirs (the conversation handled), on pairing the latest of each chat as history; and
//! that they're typing, so the triage waits. Out: a reply (no reply window: WhatsApp has none for
//! a person's own account), "typing…". Connected in the Inbox's settings: the server's QR code,
//! scanned from the phone (Linked devices). A chat is keyed by its JID; a person's handle is their
//! phone number (+<country><number>).

use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::config::WhatsappConf;
use crate::apps::pigeon::connectors::{need_str, ActionDef, Connector, Kind, Pairing};
use crate::apps::pigeon::items::{self, Author, Direction, Incoming};
use crate::apps::pigeon::sign;
use crate::apps::pigeon::state::{AppState, State};

pub struct Whatsapp;

pub const ID: &str = "whatsapp";
/// WhatsApp takes far longer texts; a reply this long is a mistake.
const MAX_TEXT: usize = 4000;

fn conf(st: &State) -> anyhow::Result<&WhatsappConf> {
    st.cfg.whatsapp.as_ref().ok_or_else(|| anyhow::anyhow!("WhatsApp is not configured"))
}

fn http() -> &'static reqwest::Client {
    static C: OnceLock<reqwest::Client> = OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("http client"))
}

/// The user's WhatsApp address book, as the phone shares it: `{phone, name, push, business}`
/// each, `name` how the user saved them.
pub async fn address_book(st: &State, user: &str) -> anyhow::Result<Vec<Json>> {
    let v = bridge(st, user, reqwest::Method::GET, "/contacts", None).await?;
    Ok(v["contacts"].as_array().cloned().unwrap_or_default())
}

/// One call to pigeon-whatsapp's API, on the user's session.
async fn bridge(st: &State, user: &str, method: reqwest::Method, path: &str, body: Option<&Json>) -> anyhow::Result<Json> {
    let c = conf(st)?;
    let url = format!("{}/u/{}{path}", c.bridge_url, urlencoding::encode(user));
    let mut req = http().request(method, url).bearer_auth(&c.secret);
    if let Some(b) = body {
        req = req.json(b);
    }
    let resp = req.send().await.map_err(|e| anyhow::anyhow!("pigeon-whatsapp unreachable: {e}"))?;
    let status = resp.status();
    let v: Json = resp.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        anyhow::bail!("pigeon-whatsapp {path}: {status} {}", v["error"].as_str().unwrap_or_default());
    }
    Ok(v)
}

/// A message as pigeon-whatsapp passes it on.
#[derive(Debug, Clone, Deserialize)]
pub struct Message {
    /// "<chat>/<WhatsApp's id>": unique across chats
    pub id: String,
    /// the chat's JID: a person's phone number (…@s.whatsapp.net), a group (…@g.us)
    pub chat: String,
    #[serde(default)]
    pub chat_name: Option<String>,
    #[serde(default)]
    pub group: bool,
    #[serde(default)]
    pub from_me: bool,
    /// "+<number>"
    #[serde(default)]
    pub sender: String,
    #[serde(default)]
    pub sender_name: Option<String>,
    #[serde(default)]
    pub text: String,
    /// milliseconds since the epoch
    pub at: i64,
    /// what's attached ("image", "voice message", "location: …")
    #[serde(default)]
    pub kinds: Vec<String>,
}

/// A message's text as an item's body: the text, and what's attached.
fn body_of(m: &Message) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !m.text.trim().is_empty() {
        parts.push(m.text.clone());
    }
    parts.extend(m.kinds.iter().map(|k| format!("[{k}]")));
    parts.join("\n")
}

/// A person's chat as their handle (their phone number); a group, or a chat WhatsApp keeps
/// hidden behind an id, as the JID.
pub fn handle_of_chat(chat: &str) -> String {
    match chat.strip_suffix("@s.whatsapp.net") {
        Some(number) => format!("+{number}"),
        None => chat.to_string(),
    }
}

fn some(s: &Option<String>) -> Option<String> {
    s.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// The user's connected account (one: a session holds one device).
async fn connection(st: &State, user: &str) -> anyhow::Result<Option<i32>> {
    Ok(sqlx::query_scalar(
        "SELECT id FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 AND status <> 'disconnected' ORDER BY updated_at DESC LIMIT 1",
    )
    .bind(ID)
    .bind(user)
    .fetch_optional(&st.pool)
    .await?)
}

/// The account's row, connected (after pairing, and at every reconnect). A number connected by
/// another user stays theirs.
async fn connected(st: &State, user: &str, phone: &str, name: &str) -> anyhow::Result<()> {
    let n = sqlx::query(
        "INSERT INTO db_pigeon_connections (user_id, connector, account, status, settings, last_ok_at, last_error)
         VALUES ($4, $1, $2, 'connected', $3, NOW(), NULL)
         ON CONFLICT (connector, account) DO UPDATE
           SET status = 'connected', settings = EXCLUDED.settings, last_ok_at = NOW(), last_error = NULL, updated_at = NOW()
           WHERE db_pigeon_connections.user_id = EXCLUDED.user_id",
    )
    .bind(ID)
    .bind(phone)
    .bind(json!({ "name": name }))
    .bind(user)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if n == 0 {
        log::warn!("whatsapp: {phone} is connected by another user");
    }
    Ok(())
}

async fn note_error(st: &State, user: &str, error: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE db_pigeon_connections SET status = 'error', last_error = $3, updated_at = NOW() WHERE connector = $1 AND user_id = $2 AND status <> 'disconnected'",
    )
    .bind(ID)
    .bind(user)
    .bind(error)
    .execute(&st.pool)
    .await?;
    Ok(())
}

/// One message as an item: its conversation, None when stored already.
async fn store(st: &State, user: &str, connection: Option<i32>, m: &Message, triage: bool) -> anyhow::Result<Option<Uuid>> {
    let name = some(&m.chat_name);
    let inc = Incoming {
        user_id: user.to_string(),
        connector: ID,
        connection_id: connection,
        thread: m.chat.clone(),
        thread_title: name.clone(),
        external_id: m.id.clone(),
        direction: if m.from_me { Direction::Out } else { Direction::In },
        author: if m.from_me { Author::Me } else { Author::Them },
        sender: Some(m.sender.clone()),
        sender_name: if m.from_me { None } else { some(&m.sender_name) },
        subject: None,
        body: body_of(m),
        media: json!(m.kinds),
        raw: json!({ "id": m.id }),
        at: Utc.timestamp_millis_opt(m.at).single().unwrap_or_else(Utc::now),
        // a group isn't a person: its conversation has no contact
        counterpart: (!m.group).then(|| (handle_of_chat(&m.chat), name)),
        window: None,
        triage,
    };
    Ok(items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?.map(|i| i.conversation_id))
}

/// One event from pigeon-whatsapp, for the user it names.
async fn take_in(st: &State, event: Json) -> anyhow::Result<()> {
    let user = event["user"].as_str().filter(|u| !u.is_empty()).ok_or_else(|| anyhow::anyhow!("an event for nobody"))?;
    let known: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM db_users WHERE id = $1)").bind(user).fetch_one(&st.pool).await?;
    if !known {
        anyhow::bail!("an event for {user}, who isn't a user here");
    }
    match event["type"].as_str().unwrap_or_default() {
        "message" => {
            let m: Message = serde_json::from_value(event["message"].clone())?;
            store(st, user, connection(st, user).await?, &m, true).await?;
        }
        "history" => {
            let msgs: Vec<Message> = serde_json::from_value(event["messages"].clone())?;
            let connection = connection(st, user).await?;
            let mut n = 0;
            for m in &msgs {
                if store(st, user, connection, m, false).await?.is_some() {
                    n += 1;
                }
            }
            log::info!("whatsapp: history, {n} new of {}", msgs.len());
        }
        "typing" => {
            if event["state"].as_str() == Some("composing") {
                let chat = event["chat"].as_str().unwrap_or_default();
                items::still_writing(&st.pool, user, ID, chat, st.cfg.triage_debounce).await?;
            }
        }
        "connected" => {
            let phone = event["phone"].as_str().unwrap_or_default();
            connected(st, user, phone, event["name"].as_str().unwrap_or_default()).await?;
            log::info!("whatsapp: {phone} connected");
        }
        "logged_out" => {
            let why = event["reason"].as_str().unwrap_or("logged out");
            log::warn!("whatsapp: logged out ({why})");
            note_error(st, user, &format!("WhatsApp logged Pigeon out ({why}): connect it again in the Inbox's settings")).await?;
        }
        "temporary_ban" => {
            let why = event["reason"].as_str().unwrap_or_default();
            log::warn!("whatsapp: temporary ban: {why}");
            note_error(st, user, &format!("WhatsApp banned the number for a while: {why}")).await?;
        }
        other => log::debug!("whatsapp: event {other:?} left"),
    }
    Ok(())
}

/// A conversation's chat, and whose it is.
async fn chat_of(st: &State, conversation: Uuid) -> anyhow::Result<(String, String)> {
    sqlx::query_as("SELECT external_id, user_id FROM db_pigeon_conversations WHERE id = $1 AND connector = $2")
        .bind(conversation)
        .bind(ID)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("{conversation} is not a WhatsApp conversation"))
}

#[async_trait]
impl Connector for Whatsapp {
    fn id(&self) -> &'static str {
        ID
    }

    fn title(&self) -> &'static str {
        "WhatsApp"
    }

    fn available(&self, st: &State) -> Result<(), String> {
        st.cfg.whatsapp.as_ref().map(|_| ()).ok_or_else(|| "PIGEON_WHATSAPP_BRIDGE_URL and PIGEON_WHATSAPP_BRIDGE_SECRET are not set".into())
    }

    fn actions(&self) -> Vec<ActionDef> {
        vec![ActionDef {
            name: "send_reply",
            kind: Kind::Reply,
            description: "Reply in this WhatsApp chat, from the user's number (in a group: to the whole group). Plain text.",
            params: json!({
                "type": "object",
                "properties": { "text": { "type": "string", "description": "The reply's text, as the user (plain text)" } },
                "required": ["text"],
            }),
            on_conversation: true,
            agent: true,
        }]
    }

    async fn run(&self, st: &State, user: &str, action: &str, args: &Json, conversation: Option<Uuid>) -> anyhow::Result<Json> {
        if action != "send_reply" {
            anyhow::bail!("whatsapp has no action '{action}'");
        }
        let conv = conversation.ok_or_else(|| anyhow::anyhow!("needs a conversation"))?;
        let (chat, owner) = chat_of(st, conv).await?;
        if owner != user {
            anyhow::bail!("{conv} is not a WhatsApp conversation");
        }
        let text = need_str(args, "text")?;
        if text.len() > MAX_TEXT {
            anyhow::bail!("the reply is {} bytes; {MAX_TEXT} at most", text.len());
        }
        let sent = bridge(st, user, reqwest::Method::POST, "/send", Some(&json!({ "chat": chat, "text": text }))).await?;
        let id = sent["id"].as_str().unwrap_or_default().to_string();
        let at = sent["at"].as_i64().and_then(|ms| Utc.timestamp_millis_opt(ms).single()).unwrap_or_else(Utc::now);
        let me = sqlx::query_scalar::<_, String>("SELECT account FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 AND status = 'connected' LIMIT 1")
            .bind(ID)
            .bind(user)
            .fetch_optional(&st.pool)
            .await?;
        let inc = Incoming {
            user_id: user.to_string(),
            connector: ID,
            connection_id: connection(st, user).await?,
            thread: chat.clone(),
            thread_title: None,
            external_id: id.clone(),
            direction: Direction::Out,
            author: Author::Pigeon,
            sender: me,
            sender_name: None,
            subject: None,
            body: text.to_string(),
            media: json!([]),
            raw: json!({ "id": id }),
            at,
            counterpart: None,
            window: None,
            triage: false,
        };
        items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?;
        Ok(json!({ "sent": true, "to": handle_of_chat(&chat), "message_id": id }))
    }

    fn shows_typing(&self) -> bool {
        true
    }

    async fn typing(&self, st: &State, conversation: Uuid, on: bool) -> anyhow::Result<()> {
        let (chat, user) = chat_of(st, conversation).await?;
        bridge(st, &user, reqwest::Method::POST, "/typing", Some(&json!({ "chat": chat, "on": on }))).await?;
        Ok(())
    }

    async fn health(&self, st: &State, user: &str) -> Json {
        if let Err(e) = self.available(st) {
            return json!({ "available": false, "why": e });
        }
        let server = match bridge(st, user, reqwest::Method::GET, "/status", None).await {
            Ok(s) => s,
            Err(e) => json!({ "error": format!("{e:#}") }),
        };
        let rows: Vec<(String, String, Option<chrono::DateTime<Utc>>, Option<String>)> =
            sqlx::query_as("SELECT account, status, last_ok_at, last_error FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 ORDER BY account")
                .bind(ID)
                .bind(user)
                .fetch_all(&st.pool)
                .await
                .unwrap_or_default();
        let accounts: Vec<Json> =
            rows.into_iter().map(|(account, status, last_ok_at, last_error)| json!({ "account": account, "status": status, "last_ok_at": last_ok_at, "last_error": last_error })).collect();
        json!({ "available": true, "server": server, "accounts": accounts })
    }

    fn connects_by_pairing(&self) -> bool {
        true
    }

    async fn connect_pairing(&self, st: &State, user: &str) -> anyhow::Result<Pairing> {
        let s = bridge(st, user, reqwest::Method::GET, "/pair", None).await?;
        Ok(match (s["state"].as_str(), s["qr_png"].as_str()) {
            (Some("connected"), _) => {
                let phone = s["phone"].as_str().unwrap_or_default();
                connected(st, user, phone, s["name"].as_str().unwrap_or_default()).await?;
                Pairing::Connected(phone.to_string())
            }
            (_, Some(png)) => Pairing::Code {
                png_base64: png.to_string(),
                how: "On your phone: WhatsApp → Settings → Linked devices → Link a device, then scan this code. It changes every few seconds; the page follows.".into(),
            },
            _ => Pairing::Waiting,
        })
    }

    async fn disconnect(&self, st: &State, user: &str, _account: &str) -> anyhow::Result<()> {
        // logged out already (the phone removed it): nothing to end
        if let Err(e) = bridge(st, user, reqwest::Method::POST, "/logout", None).await {
            log::info!("whatsapp: logging {user} out: {e:#}");
        }
        Ok(())
    }

    async fn webhook(&self, st: &AppState, signature: Option<&str>, body: &[u8]) -> anyhow::Result<bool> {
        let c = conf(st)?;
        if !sign::signature_ok(&c.secret, body, signature) {
            return Ok(false);
        }
        let event: Json = serde_json::from_slice(body)?;
        // in order (a message before its typing, history in its batches): the server waits for
        // each answer, so this is taken in before answering
        if let Err(e) = take_in(st, event).await {
            log::warn!("whatsapp: {e:#}");
        }
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chat_as_a_handle() {
        assert_eq!(handle_of_chat("393331234567@s.whatsapp.net"), "+393331234567");
        assert_eq!(handle_of_chat("120363025246125486@g.us"), "120363025246125486@g.us");
        assert_eq!(handle_of_chat("123456789@lid"), "123456789@lid");
    }

    #[test]
    fn a_message_as_a_body() {
        let m: Message = serde_json::from_value(json!({
            "id": "1@s.whatsapp.net/ABC", "chat": "1@s.whatsapp.net", "text": "look", "at": 0, "kinds": ["image"]
        }))
        .unwrap();
        assert_eq!(body_of(&m), "look\n[image]");
        assert!(!m.from_me && !m.group);
    }
}

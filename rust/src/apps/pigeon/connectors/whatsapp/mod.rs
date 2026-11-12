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
//! a person's own account), "typing…", and read receipts once the user (or Pigeon, before an
//! auto reply) read it. Connected in the Inbox's settings: the server's QR code,
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
use crate::apps::pigeon::connectors::{need_str, ActionDef, Connector, Kind, Pairing, Reacted};
use crate::apps::pigeon::items::{self, Author, Direction, Incoming};
use crate::apps::pigeon::media;
use crate::apps::pigeon::owner;
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

/// A person's WhatsApp profile picture (a link for a while), when they have one the user may see.
pub async fn picture_url(st: &State, user: &str, phone: &str) -> Option<String> {
    let c = conf(st).ok()?;
    let url = format!("{}/u/{}/avatar", c.bridge_url, urlencoding::encode(user));
    let r = http().get(url).bearer_auth(&c.secret).query(&[("phone", phone)]).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    let v: Json = r.json().await.ok()?;
    v["url"].as_str().filter(|u| !u.is_empty()).map(str::to_string)
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

/// The action that sends a file the user uploaded in the Inbox (`media::put_outgoing`): the
/// user's own, never the agent's.
pub(crate) fn send_file_def() -> ActionDef {
    ActionDef {
        name: "send_file",
        kind: Kind::Reply,
        description: "Send a photo, video, audio or file the user uploaded in the Inbox, with an optional caption. The user's only.",
        params: json!({
            "type": "object",
            "properties": {
                "file": { "type": "object", "description": "The uploaded file's entry" },
                "caption": { "type": "string" },
            },
            "required": ["file"],
        }),
        on_conversation: true,
        agent: false,
    }
}

/// A file the user uploaded, sent in `chat` through the bridge (its own message, the caption on
/// it), and stored with it.
async fn send_file(st: &State, user: &str, chat: &str, args: &Json) -> anyhow::Result<Json> {
    let f = media::own_file(user, args)?;
    let caption = args["caption"].as_str().unwrap_or_default().trim();
    if caption.len() > MAX_TEXT {
        anyhow::bail!("the caption is {} bytes; {MAX_TEXT} at most", caption.len());
    }
    let data = media::bytes(&st.pool, f["key"].as_str().unwrap_or_default()).await?;
    let mime = f["mime"].as_str().unwrap_or("application/octet-stream").to_string();
    let name = f["name"].as_str().unwrap_or("file").to_string();
    let mut form = reqwest::multipart::Form::new()
        .text("chat", chat.to_string())
        .text("kind", f["kind"].as_str().unwrap_or("document").to_string())
        .text("mime", mime.clone())
        .text("name", name.clone())
        .text("caption", caption.to_string());
    for k in ["width", "height", "seconds"] {
        if let Some(n) = f[k].as_u64() {
            form = form.text(k, n.to_string());
        }
    }
    form = form.part("file", reqwest::multipart::Part::bytes(data).file_name(name).mime_str(&mime)?);
    let c = conf(st)?;
    let url = format!("{}/u/{}/send-file", c.bridge_url, urlencoding::encode(user));
    // a video takes a while to go up to WhatsApp
    let resp = reqwest::Client::new()
        .post(url)
        .bearer_auth(&c.secret)
        .multipart(form)
        .timeout(std::time::Duration::from_secs(10 * 60))
        .send()
        .await
        .map_err(|e| anyhow::anyhow!("pigeon-whatsapp unreachable: {e}"))?;
    let status = resp.status();
    let sent: Json = resp.json().await.unwrap_or(Json::Null);
    if !status.is_success() {
        anyhow::bail!("pigeon-whatsapp /send-file: {status} {}", sent["error"].as_str().unwrap_or_default());
    }
    let id = store_sent(st, user, chat, &sent, media::body_with(caption, f), json!([f])).await?;
    Ok(json!({ "sent": true, "to": handle_of_chat(chat), "message_id": id }))
}

/// What the bridge sent (`sent`: its id and time) stored as Pigeon's, as a reply's is: the
/// message's id.
async fn store_sent(st: &State, user: &str, chat: &str, sent: &Json, body: String, media: Json) -> anyhow::Result<String> {
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
        thread: chat.to_string(),
        thread_title: None,
        external_id: id.clone(),
        direction: Direction::Out,
        author: Author::Pigeon,
        sender: me,
        sender_name: None,
        subject: None,
        body,
        media,
        raw: json!({ "id": id }),
        at,
        counterpart: None,
        window: None,
        triage: false,
    };
    items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?;
    Ok(id)
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
    /// its files, with what the bridge needs to fetch each (`POST /u/{user}/media`)
    #[serde(default)]
    pub files: Vec<Json>,
    /// who it tags
    #[serde(default)]
    pub mentions: Vec<Mention>,
}

/// Someone a message tags. The text has "@<id>" where they are: WhatsApp's id for them, their
/// number or a hidden id that says nothing to a reader.
#[derive(Debug, Clone, Deserialize)]
pub struct Mention {
    pub id: String,
    /// "+<number>", when WhatsApp has told which
    #[serde(default)]
    pub phone: Option<String>,
    /// how the user saved them in WhatsApp, else the name they gave themselves
    #[serde(default)]
    pub name: Option<String>,
    /// the user themselves
    #[serde(default)]
    pub me: bool,
}

/// A message's `media`: its files (fetched into storage), then what isn't a file (a location, a
/// contact, a poll) in words.
fn media_of(user: &str, m: &Message, at: chrono::DateTime<Utc>) -> Json {
    let mut out: Vec<Json> = Vec::new();
    let mut labels: Vec<&str> = m.kinds.iter().map(String::as_str).collect();
    for f in &m.files {
        let kind = f["kind"].as_str().unwrap_or("document");
        // the words the body has for it
        let label = match kind {
            "voice" => "voice message".to_string(),
            "document" => format!("document: {}", f["name"].as_str().unwrap_or_default()),
            k => k.to_string(),
        };
        if let Some(i) = labels.iter().position(|l| *l == label) {
            labels.remove(i);
        }
        let mut e = media::entry(user, ID, at, kind, &label, f["mime"].as_str(), f["name"].as_str(), json!({ "wa": f }));
        for k in ["size", "seconds", "width", "height"] {
            if let Some(n) = f[k].as_u64().filter(|n| *n > 0) {
                e[k] = json!(n);
            }
        }
        out.push(e);
    }
    out.extend(labels.into_iter().map(|l| json!(l)));
    Json::Array(out)
}

/// A file from the user's WhatsApp, by the details its message carried: the bridge's response,
/// the file as its body.
pub(crate) async fn media(st: &State, user: &str, details: &Json) -> Result<reqwest::Response, media::Miss> {
    let c = conf(st).map_err(|e| media::Miss::Failed(e.to_string()))?;
    let url = format!("{}/u/{}/media", c.bridge_url, urlencoding::encode(user));
    static LONG: OnceLock<reqwest::Client> = OnceLock::new();
    let http = LONG.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(30 * 60)).build().expect("http client"));
    let resp = http.post(url).bearer_auth(&c.secret).json(details).send().await.map_err(|e| media::Miss::Failed(format!("pigeon-whatsapp unreachable: {e}")))?;
    let status = resp.status();
    if status.is_success() {
        return Ok(resp);
    }
    let v: Json = resp.json().await.unwrap_or(Json::Null);
    Err(media::bridge_miss(status, v["error"].as_str().unwrap_or_default().to_string()))
}

/// A message's text as an item's body: the text (its tags as names: `named`), and what's attached.
fn body_of(m: &Message, tags: &[Json]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !m.text.trim().is_empty() {
        parts.push(named(&m.text, tags));
    }
    parts.extend(m.kinds.iter().map(|k| format!("[{k}]")));
    parts.join("\n")
}

/// Who a message tags, as the Inbox keeps them (an item's `raw.mentions`): `{id, name, phone,
/// me}`. The name is the one to read: the user's own, the person's in the Inbox, the one
/// WhatsApp has for them, else their number; none when WhatsApp told nothing about the id.
async fn tags_of(st: &State, user: &str, m: &Message) -> anyhow::Result<Vec<Json>> {
    if m.mentions.is_empty() {
        return Ok(Vec::new());
    }
    let phones: Vec<String> = m.mentions.iter().filter_map(|t| some(&t.phone)).collect();
    let known: Vec<(String, Option<String>)> = sqlx::query_as(
        "SELECT h.handle, c.name FROM db_pigeon_contact_handles h JOIN db_pigeon_contacts c ON c.id = h.contact_id
          WHERE h.user_id = $1 AND h.connector = $2 AND h.handle = ANY($3)",
    )
    .bind(user)
    .bind(ID)
    .bind(&phones)
    .fetch_all(&st.pool)
    .await?;
    let mut me: Option<String> = None;
    let mut out = Vec::new();
    for t in &m.mentions {
        let phone = some(&t.phone);
        let name = if t.me {
            if me.is_none() {
                me = Some(owner::get(&st.pool, user).await.name);
            }
            me.clone()
        } else {
            // a person saved as their number has no name yet: WhatsApp's is better
            let saved = phone.as_ref().and_then(|p| known.iter().find(|(h, _)| h == p)).and_then(|(_, n)| some(n)).filter(|n| n.chars().any(char::is_alphabetic));
            saved.or_else(|| some(&t.name)).or_else(|| phone.clone())
        };
        out.push(json!({ "id": t.id, "name": name, "phone": phone, "me": t.me }));
    }
    Ok(out)
}

/// A text with its tags as names: "@111222333444555" as "@Marco". A tag nobody could be put to
/// stays as WhatsApp wrote it.
fn named(text: &str, tags: &[Json]) -> String {
    if tags.is_empty() || !text.contains('@') {
        return text.to_string();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('@') {
        out.push_str(&rest[..=at]);
        rest = &rest[at + 1..];
        // the id is the whole run after the @: "@12" isn't the start of "@123"
        let end = rest.find(|c: char| !c.is_ascii_alphanumeric()).unwrap_or(rest.len());
        let name = tags.iter().find(|t| t["id"].as_str() == Some(&rest[..end]) && end > 0).and_then(|t| t["name"].as_str());
        if let Some(name) = name {
            out.push_str(name);
            rest = &rest[end..];
        }
    }
    out.push_str(rest);
    out
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
    let at = Utc.timestamp_millis_opt(m.at).single().unwrap_or_else(Utc::now);
    let tags = tags_of(st, user, m).await?;
    let mut raw = json!({ "id": m.id });
    if !tags.is_empty() {
        raw["mentions"] = json!(tags);
    }
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
        body: body_of(m, &tags),
        media: media_of(user, m, at),
        raw,
        at,
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
        "reaction" => {
            let r = &event["reaction"];
            let text = |k: &str| r[k].as_str().map(str::trim).filter(|s| !s.is_empty());
            let target = text("target").ok_or_else(|| anyhow::anyhow!("a reaction to nothing"))?;
            let at = r["at"].as_i64().and_then(|ms| Utc.timestamp_millis_opt(ms).single()).unwrap_or_else(Utc::now);
            let me = r["from_me"].as_bool().unwrap_or(false);
            items::react(&st.pool, user, ID, target, text("sender").unwrap_or("someone"), me, text("sender_name"), text("emoji"), at).await?;
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
        }, send_file_def()]
    }

    async fn run(&self, st: &State, user: &str, action: &str, args: &Json, conversation: Option<Uuid>) -> anyhow::Result<Json> {
        if action != "send_reply" && action != "send_file" {
            anyhow::bail!("whatsapp has no action '{action}'");
        }
        let conv = conversation.ok_or_else(|| anyhow::anyhow!("needs a conversation"))?;
        let (chat, owner) = chat_of(st, conv).await?;
        if owner != user {
            anyhow::bail!("{conv} is not a WhatsApp conversation");
        }
        if action == "send_file" {
            return send_file(st, user, &chat, args).await;
        }
        let text = need_str(args, "text")?;
        if text.len() > MAX_TEXT {
            anyhow::bail!("the reply is {} bytes; {MAX_TEXT} at most", text.len());
        }
        let sent = bridge(st, user, reqwest::Method::POST, "/send", Some(&json!({ "chat": chat, "text": text }))).await?;
        let id = store_sent(st, user, &chat, &sent, text.to_string(), json!([])).await?;
        Ok(json!({ "sent": true, "to": handle_of_chat(&chat), "message_id": id }))
    }

    fn shows_typing(&self) -> bool {
        true
    }

    async fn react(&self, st: &State, conversation: Uuid, m: &Reacted, emoji: &str) -> anyhow::Result<()> {
        let (chat, user) = chat_of(st, conversation).await?;
        let body = json!({ "chat": chat, "message": m.external_id, "from_me": m.mine, "sender": m.sender, "emoji": emoji });
        bridge(st, &user, reqwest::Method::POST, "/react", Some(&body)).await?;
        Ok(())
    }

    async fn typing(&self, st: &State, conversation: Uuid, on: bool) -> anyhow::Result<()> {
        let (chat, user) = chat_of(st, conversation).await?;
        bridge(st, &user, reqwest::Method::POST, "/typing", Some(&json!({ "chat": chat, "on": on }))).await?;
        Ok(())
    }

    async fn seen(&self, st: &State, conversation: Uuid) -> anyhow::Result<()> {
        let (chat, user) = chat_of(st, conversation).await?;
        // theirs since someone on the user's side last wrote: the earlier ones were read then
        let unanswered: Vec<(String, Option<String>)> = sqlx::query_as(
            "SELECT external_id, sender FROM db_pigeon_items
              WHERE conversation_id = $1 AND author = 'them'
                AND at > COALESCE((SELECT MAX(at) FROM db_pigeon_items WHERE conversation_id = $1 AND author <> 'them'), '-infinity')
              ORDER BY at DESC LIMIT 50",
        )
        .bind(conversation)
        .fetch_all(&st.pool)
        .await?;
        if unanswered.is_empty() {
            return Ok(());
        }
        let messages: Vec<Json> = unanswered.into_iter().map(|(id, sender)| json!({ "id": id, "sender": sender })).collect();
        bridge(st, &user, reqwest::Method::POST, "/read", Some(&json!({ "chat": chat, "messages": messages }))).await?;
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
        assert_eq!(body_of(&m, &[]), "look\n[image]");
        assert!(!m.from_me && !m.group && m.mentions.is_empty());
    }

    #[test]
    fn tags_as_names() {
        let tags = [
            json!({ "id": "111222333444555", "name": "Marco Rossi", "phone": "+393331234567", "me": false }),
            json!({ "id": "66677788899900", "name": "Anna", "phone": null, "me": true }),
            // WhatsApp told nothing about this one
            json!({ "id": "777", "name": null, "phone": null, "me": false }),
        ];
        assert_eq!(named("@111222333444555 @66677788899900 andiamo?", &tags), "@Marco Rossi @Anna andiamo?");
        assert_eq!(named("ok @66677788899900, e @777?", &tags), "ok @Anna, e @777?");
        // a longer number isn't the tag, nor is an address
        assert_eq!(named("@1112223334445559 a@b.it @", &tags), "@1112223334445559 a@b.it @");
        assert_eq!(named("città @66677788899900è", &tags), "città @Annaè");
        let m: Message = serde_json::from_value(json!({
            "id": "1@g.us/ABC", "chat": "1@g.us", "group": true, "text": "@777 @66677788899900", "at": 0,
            "mentions": [{ "id": "777" }, { "id": "66677788899900", "phone": "+393330000000", "me": true }]
        }))
        .unwrap();
        assert!(m.mentions[1].me && m.mentions[0].phone.is_none());
        assert_eq!(body_of(&m, &tags), "@777 @Anna");
    }
}

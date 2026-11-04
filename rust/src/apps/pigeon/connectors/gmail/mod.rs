//! gmail: the user's mailbox. Connected by a one-time link (Google's consent screen, scope
//! gmail.modify); its refresh token is encrypted in `db_pigeon_connections`. In: polled every
//! PIGEON_GMAIL_POLL_SECS through the history API from the last historyId (`cursor`), each new
//! message stored as an item of its thread; on connect, the last two days come in as history
//! (seen, not triaged); `gather` brings older threads in the same way, for learning about people.
//! Out: a reply in the thread (to everyone on it), a new email (the user's own, or Piuma's draft
//! they sent; never the agent's), archive, mark read, trash (the user's and their rules' only).

pub mod api;
pub mod parse;

use std::collections::HashMap;

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::connectors::{need_str, ActionDef, Connector, Kind};
use crate::apps::pigeon::items::{self, Author, Direction, Incoming};
use crate::apps::pigeon::media;
use crate::apps::shares::crypto;
use crate::apps::pigeon::state::{AppState, State};
use api::Got;

pub struct Gmail;

/// An email as it was sent: its HTML, fetched from Gmail once and made safe to show
/// (`parse::email_page`), then kept on the message. None: the email has no HTML, or it isn't one
/// of the user's emails.
pub async fn html_of(st: &State, user: &str, item: Uuid) -> anyhow::Result<Option<String>> {
    let found: Option<(String, Option<i32>)> = sqlx::query_as(
        "SELECT i.external_id, c.connection_id FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE i.id = $1 AND c.user_id = $2 AND i.connector = $3",
    )
    .bind(item)
    .bind(user)
    .bind(ID)
    .fetch_optional(&st.pool)
    .await?;
    let Some((mid, Some(connection))) = found else { return Ok(None) };
    // kept on the message once made ("": it has none)
    let kept: Option<String> = sqlx::query_scalar("SELECT raw->>'page' FROM db_pigeon_items WHERE id = $1").bind(item).fetch_one(&st.pool).await?;
    if let Some(page) = kept {
        return Ok(Some(page).filter(|p| !p.is_empty()));
    }
    let token = api::access_token(st, connection).await?;
    let msg = api::gmail_ok(&token, "GET", &format!("/messages/{mid}"), &[("format", "full".to_string())], None).await?;
    let page = parse::html(&msg["payload"]).map(|h| parse::email_page(&h));
    sqlx::query("UPDATE db_pigeon_items SET raw = jsonb_set(COALESCE(raw, '{}'::jsonb), '{page}', to_jsonb($2::text)) WHERE id = $1")
        .bind(item)
        .bind(page.as_deref().unwrap_or(""))
        .execute(&st.pool)
        .await?;
    Ok(page)
}

/// An email's attached file, from Gmail (`mid`: its message, `aid`: the attachment).
pub async fn attachment(st: &State, user: &str, item: Uuid, mid: &str, aid: &str) -> anyhow::Result<Vec<u8>> {
    let connection: Option<Option<i32>> = sqlx::query_scalar(
        "SELECT c.connection_id FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id WHERE i.id = $1 AND c.user_id = $2",
    )
    .bind(item)
    .bind(user)
    .fetch_optional(&st.pool)
    .await?;
    let connection = connection.flatten().ok_or_else(|| anyhow::anyhow!("no Gmail connection for this message"))?;
    let token = api::access_token(st, connection).await?;
    let v = api::gmail_ok(&token, "GET", &format!("/messages/{mid}/attachments/{aid}"), &[], None).await?;
    let data = v["data"].as_str().ok_or_else(|| anyhow::anyhow!("Gmail sent no data"))?;
    use base64::Engine;
    Ok(base64::engine::general_purpose::URL_SAFE
        .decode(data)
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(data))?)
}

/// An email's attachments as its `media`, to fetch into storage.
fn media_of(user: &str, p: &parse::Parsed, at: chrono::DateTime<Utc>) -> Json {
    Json::Array(
        p.attachments
            .iter()
            .map(|a| {
                let kind = match a.mime.split('/').next().unwrap_or_default() {
                    "image" => "image",
                    "video" => "video",
                    "audio" => "audio",
                    _ => "document",
                };
                let mut e = media::entry(user, ID, at, kind, &a.name, Some(&a.mime), Some(&a.name), json!({ "gmail": { "message": p.id, "attachment": a.id } }));
                if a.size > 0 {
                    e["size"] = json!(a.size);
                }
                e
            })
            .collect(),
    )
}

/// archive, mark_read and trash: the whole thread, or one message of it.
fn message_param() -> Json {
    json!({ "type": "object", "properties": {
        "message_id": { "type": "string", "description": "Only this message of the thread (its Gmail id); the whole thread when left out" },
    } })
}

pub const ID: &str = "gmail";
/// Labels whose messages are never items.
/// The largest file attached to a reply (Gmail's own limit for what it sends is 25 MB).
const MAX_ATTACHMENT: i64 = 25 << 20;
const SKIP_LABELS: &[&str] = &["DRAFT", "SPAM", "TRASH", "CHAT"];

#[async_trait]
impl Connector for Gmail {
    fn id(&self) -> &'static str {
        ID
    }

    fn title(&self) -> &'static str {
        "Gmail"
    }

    fn available(&self, st: &State) -> Result<(), String> {
        st.cfg.google.as_ref().map(|_| ()).ok_or_else(|| "PIGEON_GOOGLE_CLIENT_ID and PIGEON_GOOGLE_CLIENT_SECRET are not set".into())
    }

    fn actions(&self) -> Vec<ActionDef> {
        vec![
            ActionDef {
                name: "send_reply",
                kind: Kind::Reply,
                description: "Reply by email in this thread, from the user's address: to whoever wrote last, with everyone else on their email copied (reply all).",
                params: json!({
                    "type": "object",
                    "properties": { "text": { "type": "string", "description": "The reply's text, as the user (plain text)" } },
                    "required": ["text"],
                }),
                on_conversation: true,
                agent: true,
            },
            super::whatsapp::send_file_def(),
            ActionDef {
                name: "send",
                kind: Kind::Reply,
                description: "A new email, its own thread, from the user's address to one address. Only the user sends it (Piuma drafts it): the agent is never offered it.",
                params: json!({
                    "type": "object",
                    "properties": {
                        "to": { "type": "string", "description": "One email address" },
                        "subject": { "type": "string" },
                        "text": { "type": "string", "description": "The email's text, as the user (plain text)" },
                        "from": { "type": "string", "description": "Which connected Gmail account, when there's more than one" },
                    },
                    "required": ["to", "subject", "text"],
                }),
                on_conversation: false,
                agent: false,
            },
            ActionDef {
                name: "archive",
                kind: Kind::Organize,
                description: "Archive this email thread, or one message of it (out of the inbox, kept in All Mail).",
                params: message_param(),
                on_conversation: true,
                agent: true,
            },
            ActionDef {
                name: "mark_read",
                kind: Kind::Organize,
                description: "Mark this email thread, or one message of it, as read.",
                params: message_param(),
                on_conversation: true,
                agent: true,
            },
            ActionDef {
                name: "trash",
                kind: Kind::Organize,
                description: "Move this email thread, or one message of it, to Gmail's Trash (Gmail deletes it for good after 30 days). The user's and their rules' only: the agent is never offered it.",
                params: message_param(),
                on_conversation: true,
                agent: false,
            },
        ]
    }

    async fn run(&self, st: &State, user: &str, action: &str, args: &Json, conversation: Option<Uuid>) -> anyhow::Result<Json> {
        if action == "send" {
            return send_new(st, user, args).await;
        }
        let conv = conversation.ok_or_else(|| anyhow::anyhow!("needs a conversation"))?;
        let (thread, connection): (String, Option<i32>) =
            sqlx::query_as("SELECT external_id, connection_id FROM db_pigeon_conversations WHERE id = $1 AND connector = $2 AND user_id = $3")
                .bind(conv)
                .bind(ID)
                .bind(user)
                .fetch_optional(&st.pool)
                .await?
                .ok_or_else(|| anyhow::anyhow!("{conv} is not a Gmail conversation"))?;
        let connection = connection.ok_or_else(|| anyhow::anyhow!("the conversation has no Gmail account"))?;
        let token = api::access_token(st, connection).await?;
        match action {
            "send_reply" => send_reply(st, user, connection, &token, conv, &thread, need_str(args, "text")?, None).await,
            "send_file" => {
                let f = media::own_file(user, args)?;
                if f["size"].as_i64().unwrap_or(0) > MAX_ATTACHMENT {
                    anyhow::bail!("Gmail takes files up to {} MB", MAX_ATTACHMENT >> 20);
                }
                let data = media::bytes(&st.pool, f["key"].as_str().unwrap_or_default()).await?;
                let file = parse::OutFile {
                    name: f["name"].as_str().map(str::to_string).unwrap_or_else(|| {
                        let key = f["key"].as_str().unwrap_or_default();
                        key.rsplit('/').next().unwrap_or("file").to_string()
                    }),
                    mime: f["mime"].as_str().unwrap_or("application/octet-stream").to_string(),
                    data,
                };
                let caption = args["caption"].as_str().unwrap_or_default().trim();
                send_reply(st, user, connection, &token, conv, &thread, caption, Some((file, f))).await
            }
            "archive" | "mark_read" | "trash" => {
                // one message of the thread, when named (and it is of this thread), or all of it
                let target = match crate::apps::pigeon::connectors::arg_str(args, "message_id") {
                    Some(mid) => {
                        let ours: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM db_pigeon_items WHERE conversation_id = $1 AND connector = $2 AND external_id = $3)")
                            .bind(conv)
                            .bind(ID)
                            .bind(mid)
                            .fetch_one(&st.pool)
                            .await?;
                        if !ours {
                            anyhow::bail!("message {mid} is not in this conversation");
                        }
                        format!("/messages/{mid}")
                    }
                    None => format!("/threads/{thread}"),
                };
                if action == "trash" {
                    api::gmail_ok(&token, "POST", &format!("{target}/trash"), &[], None).await?;
                    return Ok(json!({ "trashed": target }));
                }
                let label = if action == "archive" { "INBOX" } else { "UNREAD" };
                api::gmail_ok(&token, "POST", &format!("{target}/modify"), &[], Some(&json!({ "removeLabelIds": [label] }))).await?;
                Ok(json!({ "modified": target, "removed": label }))
            }
            other => anyhow::bail!("gmail has no action '{other}'"),
        }
    }

    async fn gather(&self, st: &State, user: &str, handle: Option<&str>, days: i64, max_threads: usize) -> anyhow::Result<usize> {
        let q = match handle {
            Some(h) => {
                if !h.contains('@') || h.contains(|c: char| c.is_whitespace() || "{}()\"".contains(c)) {
                    anyhow::bail!("{h} is not an email address");
                }
                format!("{{from:{h} to:{h} cc:{h}}} newer_than:{days}d")
            }
            None => format!("in:sent newer_than:{days}d"),
        };
        let accounts: Vec<(i32, String)> =
            sqlx::query_as("SELECT id, account FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 AND status <> 'disconnected' ORDER BY id")
                .bind(ID)
                .bind(user)
                .fetch_all(&st.pool)
                .await?;
        let mut n = 0;
        for (id, account) in accounts {
            n += gather_threads(st, &Conn { id, user, account: &account }, &q, max_threads).await?;
        }
        Ok(n)
    }

    fn start(&self, st: AppState) {
        let every = st.cfg.gmail_poll;
        tokio::spawn(async move {
            loop {
                if let Err(e) = poll_all(&st).await {
                    log::warn!("gmail: {e:#}");
                }
                tokio::time::sleep(every).await;
            }
        });
    }

    async fn health(&self, st: &State, user: &str) -> Json {
        if let Err(e) = self.available(st) {
            return json!({ "available": false, "why": e });
        }
        let rows: Vec<(String, String, Option<chrono::DateTime<Utc>>, Option<String>)> = sqlx::query_as(
            "SELECT account, status, last_ok_at, last_error FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 ORDER BY account",
        )
        .bind(ID)
        .bind(user)
        .fetch_all(&st.pool)
        .await
        .unwrap_or_default();
        let accounts: Vec<Json> = rows
            .into_iter()
            .map(|(account, status, last_ok_at, last_error)| json!({ "account": account, "status": status, "last_ok_at": last_ok_at, "last_error": last_error }))
            .collect();
        json!({ "available": true, "accounts": accounts })
    }

    fn connects_by_link(&self) -> bool {
        true
    }

    async fn connect_start(&self, st: &State, token: &str) -> anyhow::Result<String> {
        let g = st.cfg.google.as_ref().ok_or_else(|| anyhow::anyhow!("Google is not configured"))?;
        let q = [
            ("client_id", g.client_id.as_str()),
            ("redirect_uri", &api::redirect_uri(st)),
            ("response_type", "code"),
            ("scope", api::SCOPES),
            ("access_type", "offline"),
            // a refresh token every time, even for an account connected before
            ("prompt", "consent"),
            ("state", token),
        ];
        let qs: Vec<String> = q.iter().map(|(k, v)| format!("{k}={}", urlencoding::encode(v))).collect();
        Ok(format!("{}?{}", api::AUTH_URL, qs.join("&")))
    }

    async fn connect_finish(&self, st: &State, user: &str, query: &HashMap<String, String>) -> anyhow::Result<String> {
        if let Some(e) = query.get("error") {
            anyhow::bail!("Google said: {e}");
        }
        let code = query.get("code").ok_or_else(|| anyhow::anyhow!("Google sent no code"))?;
        let g = st.cfg.google.as_ref().ok_or_else(|| anyhow::anyhow!("Google is not configured"))?;
        let tok = api::exchange(st, g, code).await?;
        let access = tok["access_token"].as_str().ok_or_else(|| anyhow::anyhow!("Google's answer has no access_token"))?;
        let refresh = tok["refresh_token"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("Google sent no refresh token: remove Pigeon's access in your Google account and connect again"))?;
        let profile = api::gmail_ok(access, "GET", "/profile", &[], None).await?;
        let account = profile["emailAddress"].as_str().ok_or_else(|| anyhow::anyhow!("no address in the Gmail profile"))?.to_lowercase();
        let history_id = profile["historyId"].as_str().map(str::to_string).or_else(|| profile["historyId"].as_u64().map(|n| n.to_string()));
        let sealed = crypto::encrypt(&st.pool, &json!({ "refresh_token": refresh }).to_string()).await.map_err(|e| anyhow::anyhow!(e))?;
        // an account is one user's: connected by someone else already, it's refused
        let id: Option<i32> = sqlx::query_scalar(
            "INSERT INTO db_pigeon_connections (user_id, connector, account, status, secret, cursor, last_ok_at, last_error)
             VALUES ($5, $1, $2, 'connected', $3, $4, NOW(), NULL)
             ON CONFLICT (connector, account) DO UPDATE
               SET status = 'connected', secret = EXCLUDED.secret, cursor = EXCLUDED.cursor, last_ok_at = NOW(), last_error = NULL, updated_at = NOW()
               WHERE db_pigeon_connections.user_id = EXCLUDED.user_id
             RETURNING id",
        )
        .bind(ID)
        .bind(&account)
        .bind(&sealed)
        .bind(&history_id)
        .bind(user)
        .fetch_optional(&st.pool)
        .await?;
        let id = id.ok_or_else(|| anyhow::anyhow!("{account} is connected by another user"))?;
        api::forget(id).await;
        // the last two days, as history: context for the conversations, not triaged
        match import_recent(st, &Conn { id, user, account: &account }, access).await {
            Ok(n) => log::info!("gmail {account}: connected, {n} recent message(s) brought in"),
            Err(e) => log::warn!("gmail {account}: connected, but the recent mail didn't come in: {e:#}"),
        }
        Ok(account)
    }
}

/// One connected account: its row, whose it is, its address.
struct Conn<'a> {
    id: i32,
    user: &'a str,
    account: &'a str,
}

async fn poll_all(st: &State) -> anyhow::Result<()> {
    let conns: Vec<(i32, String, String, Option<String>)> =
        sqlx::query_as("SELECT id, user_id, account, cursor FROM db_pigeon_connections WHERE connector = $1 AND status <> 'disconnected'")
            .bind(ID)
            .fetch_all(&st.pool)
            .await?;
    for (id, user, account, cursor) in conns {
        let r = poll(st, &Conn { id, user: &user, account: &account }, cursor).await;
        let (status, err) = match &r {
            Ok(_) => ("connected", None),
            Err(e) => {
                log::warn!("gmail {account}: {e:#}");
                ("error", Some(format!("{e:#}")))
            }
        };
        sqlx::query(
            "UPDATE db_pigeon_connections SET status = $2, last_error = $3, last_ok_at = CASE WHEN $3::text IS NULL THEN NOW() ELSE last_ok_at END,
                    updated_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .bind(status)
        .bind(err)
        .execute(&st.pool)
        .await?;
    }
    Ok(())
}

/// What arrived since `cursor`, each message stored; the cursor moves on.
async fn poll(st: &State, c: &Conn<'_>, cursor: Option<String>) -> anyhow::Result<()> {
    let (id, account) = (c.id, c.account);
    let token = api::access_token(st, id).await?;
    let Some(start) = cursor else {
        // no cursor (a first connect that failed half-way): start from now
        let profile = api::gmail_ok(&token, "GET", "/profile", &[], None).await?;
        set_cursor(st, id, &history_id(&profile)).await?;
        return Ok(());
    };
    let mut page: Option<String> = None;
    let mut newest = start.clone();
    let mut ids: Vec<String> = Vec::new();
    loop {
        let mut q = vec![("startHistoryId", start.clone()), ("historyTypes", "messageAdded".to_string()), ("maxResults", "500".to_string())];
        if let Some(p) = &page {
            q.push(("pageToken", p.clone()));
        }
        let res = match api::gmail(&token, "GET", "/history", &q, None).await? {
            Got::Ok(v) => v,
            Got::NotFound => {
                // the cursor is too old for Gmail's history: bring in the last day and start again from now
                log::warn!("gmail {account}: history from {start} is gone, catching up on the last day");
                import_recent_query(st, c, &token, "newer_than:1d", true).await?;
                let profile = api::gmail_ok(&token, "GET", "/profile", &[], None).await?;
                set_cursor(st, id, &history_id(&profile)).await?;
                return Ok(());
            }
        };
        for h in res["history"].as_array().into_iter().flatten() {
            for m in h["messagesAdded"].as_array().into_iter().flatten() {
                if let Some(mid) = m["message"]["id"].as_str() {
                    if !ids.iter().any(|x| x == mid) {
                        ids.push(mid.to_string());
                    }
                }
            }
        }
        if let Some(h) = res["historyId"].as_str() {
            newest = h.to_string();
        }
        page = res["nextPageToken"].as_str().map(str::to_string);
        if page.is_none() {
            break;
        }
    }
    for mid in &ids {
        if let Err(e) = take_in(st, c, &token, mid, true).await {
            log::warn!("gmail {account}: message {mid}: {e:#}");
        }
    }
    if newest != start {
        set_cursor(st, id, &newest).await?;
    }
    Ok(())
}

fn history_id(profile: &Json) -> String {
    profile["historyId"].as_str().map(str::to_string).or_else(|| profile["historyId"].as_u64().map(|n| n.to_string())).unwrap_or_default()
}

async fn set_cursor(st: &State, id: i32, cursor: &str) -> anyhow::Result<()> {
    sqlx::query("UPDATE db_pigeon_connections SET cursor = $2, updated_at = NOW() WHERE id = $1").bind(id).bind(cursor).execute(&st.pool).await?;
    Ok(())
}

async fn import_recent(st: &State, c: &Conn<'_>, token: &str) -> anyhow::Result<usize> {
    import_recent_query(st, c, token, "newer_than:2d", false).await
}

async fn import_recent_query(st: &State, c: &Conn<'_>, token: &str, q: &str, triage: bool) -> anyhow::Result<usize> {
    let list = api::gmail_ok(token, "GET", "/messages", &[("q", q.to_string()), ("maxResults", "200".to_string())], None).await?;
    let mut n = 0;
    for m in list["messages"].as_array().into_iter().flatten() {
        if let Some(mid) = m["id"].as_str() {
            match take_in(st, c, token, mid, triage).await {
                Ok(true) => n += 1,
                Ok(false) => {}
                Err(e) => log::warn!("gmail {}: message {mid}: {e:#}", c.account),
            }
        }
    }
    Ok(n)
}

/// One message as an item. False when skipped (a draft, spam) or stored already.
async fn take_in(st: &State, c: &Conn<'_>, token: &str, mid: &str, triage: bool) -> anyhow::Result<bool> {
    let msg = match api::gmail(token, "GET", &format!("/messages/{mid}"), &[("format", "full".to_string())], None).await? {
        Got::Ok(v) => v,
        Got::NotFound => return Ok(false), // deleted since
    };
    store(st, c, &msg, triage).await
}

/// A message Gmail gave in full, stored as an item.
async fn store(st: &State, c: &Conn<'_>, msg: &Json, triage: bool) -> anyhow::Result<bool> {
    let (connection, account) = (c.id, c.account);
    let p = parse::parse(msg);
    if p.labels.iter().any(|l| SKIP_LABELS.contains(&l.as_str())) {
        return Ok(false);
    }
    // stored before its text could be read (a blank text part hid the HTML, a forward cut to its
    // first lines): the whole text now
    if !p.body.trim().is_empty() {
        let n = sqlx::query(
            "UPDATE db_pigeon_items SET body = $3 WHERE connector = $1 AND external_id = $2
               AND conversation_id IN (SELECT id FROM db_pigeon_conversations WHERE user_id = $4)
               AND (trim(body) = '' OR (length($3) > length(body) AND strpos($3, trim(body)) > 0))",
        )
            .bind(ID)
            .bind(&p.id)
            .bind(&p.body)
            .bind(c.user)
            .execute(&st.pool)
            .await?
            .rows_affected();
        if n > 0 {
            log::info!("gmail {account}: message {} read again, its text filled in", p.id);
            return Ok(false);
        }
    }
    let sent = p.labels.iter().any(|l| l == "SENT") || p.from.as_ref().is_some_and(|(a, _)| a == account);
    let counterpart = if sent { p.to.first().cloned() } else { p.reply_to.clone().or_else(|| p.from.clone()) };
    let at = Utc.timestamp_millis_opt(p.internal_date).single().unwrap_or_else(Utc::now);
    let inc = Incoming {
        user_id: c.user.to_string(),
        connector: ID,
        connection_id: Some(connection),
        thread: p.thread_id.clone(),
        thread_title: p.subject.clone(),
        external_id: p.id.clone(),
        direction: if sent { Direction::Out } else { Direction::In },
        author: if sent { Author::Me } else { Author::Them },
        sender: p.from.as_ref().map(|(a, _)| a.clone()),
        sender_name: p.from.as_ref().and_then(|(_, n)| n.clone()),
        subject: p.subject.clone(),
        body: p.body.clone(),
        media: media_of(c.user, &p, at),
        raw: json!({
            "labels": p.labels,
            "message_id": p.message_id,
            "references": p.references,
            "reply_to": p.reply_to.as_ref().map(|(a, _)| a),
            "to": p.to.iter().map(|(a, _)| a).collect::<Vec<_>>(),
            "cc": p.cc.iter().map(|(a, _)| a).collect::<Vec<_>>(),
        }),
        at,
        counterpart,
        window: None,
        triage,
    };
    Ok(items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?.is_some())
}

/// A new email to one address, from the connected account (`from` picks one when there are more).
/// Stored as Pigeon's item of the new thread, with the address as who the conversation is with.
async fn send_new(st: &State, user: &str, args: &Json) -> anyhow::Result<Json> {
    let to = need_str(args, "to")?.to_lowercase();
    let subject = need_str(args, "subject")?;
    let text = need_str(args, "text")?;
    let one_line = |v: &str| !v.contains(['\r', '\n']);
    if !one_line(&to) || !one_line(subject) || to.contains([',', ';', '<', '>', ' ']) || to.split('@').filter(|p| !p.is_empty()).count() != 2 {
        anyhow::bail!("`to` must be one email address and `subject` one line");
    }
    let accounts: Vec<(i32, String)> =
        sqlx::query_as("SELECT id, account FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 AND status = 'connected' ORDER BY id")
            .bind(ID)
            .bind(user)
            .fetch_all(&st.pool)
            .await?;
    let (connection, account) = match crate::apps::pigeon::connectors::arg_str(args, "from") {
        Some(from) => accounts.into_iter().find(|(_, a)| a.eq_ignore_ascii_case(from)).ok_or_else(|| anyhow::anyhow!("no connected Gmail account {from}"))?,
        None => match accounts.len() {
            0 => anyhow::bail!("no Gmail account is connected"),
            1 => accounts.into_iter().next().expect("one"),
            _ => anyhow::bail!("more than one Gmail account: say which with `from`"),
        },
    };
    let token = api::access_token(st, connection).await?;
    let mime = parse::new_raw(&account, &to, subject, text);
    let sent = api::gmail_ok(&token, "POST", "/messages/send", &[], Some(&json!({ "raw": mime }))).await?;
    let mid = sent["id"].as_str().unwrap_or_default().to_string();
    let thread = sent["threadId"].as_str().unwrap_or(&mid).to_string();
    let inc = Incoming {
        user_id: user.to_string(),
        connector: ID,
        connection_id: Some(connection),
        thread: thread.clone(),
        thread_title: Some(subject.to_string()),
        external_id: mid.clone(),
        direction: Direction::Out,
        author: Author::Pigeon,
        sender: Some(account.clone()),
        sender_name: None,
        subject: Some(subject.to_string()),
        body: text.to_string(),
        media: json!([]),
        raw: json!({ "labels": ["SENT"], "to": [to] }),
        at: Utc::now(),
        counterpart: Some((to.clone(), None)),
        window: None,
        triage: false,
    };
    let stored = items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?;
    Ok(json!({ "sent": true, "from": account, "to": to, "message_id": mid, "thread": thread,
               "conversation_id": stored.map(|s| s.conversation_id) }))
}

/// Reply to the last message from them in the thread, threaded (In-Reply-To, References,
/// threadId); stored at once as sent by Pigeon, so the next poll finds it there.
/// `file`: one the user uploaded (`media::put_outgoing`), attached, and its entry for the message.
#[allow(clippy::too_many_arguments)]
async fn send_reply(
    st: &State,
    user: &str,
    connection: i32,
    token: &str,
    conv: Uuid,
    thread: &str,
    text: &str,
    file: Option<(parse::OutFile, &Json)>,
) -> anyhow::Result<Json> {
    let account: String = sqlx::query_scalar("SELECT account FROM db_pigeon_connections WHERE id = $1").bind(connection).fetch_one(&st.pool).await?;
    let last: Option<(Option<String>, Option<String>, Option<Json>)> = sqlx::query_as(
        "SELECT sender, subject, raw FROM db_pigeon_items WHERE conversation_id = $1 AND direction = 'in' ORDER BY at DESC LIMIT 1",
    )
    .bind(conv)
    .fetch_optional(&st.pool)
    .await?;
    let (sender, subject, raw) = last.ok_or_else(|| anyhow::anyhow!("nobody wrote in this thread to reply to"))?;
    let raw = raw.unwrap_or(Json::Null);
    let to = raw["reply_to"].as_str().map(str::to_string).or(sender).ok_or_else(|| anyhow::anyhow!("no address to reply to"))?;
    let cc = reply_all_cc(&raw, &account, &to);
    let (body, media) = match &file {
        Some((_, entry)) => (media::body_with(text, entry), json!([entry])),
        None => (text.to_string(), json!([])),
    };
    let sent = match file {
        None => {
            let mime = parse::reply_raw(&account, &to, &cc, subject.as_deref().unwrap_or(""), raw["message_id"].as_str(), raw["references"].as_str(), text);
            api::gmail_ok(token, "POST", "/messages/send", &[], Some(&json!({ "raw": mime, "threadId": thread }))).await?
        }
        Some((attachment, _)) => {
            let message = parse::reply_message(
                &account,
                &to,
                &cc,
                subject.as_deref().unwrap_or(""),
                raw["message_id"].as_str(),
                raw["references"].as_str(),
                text,
                &[attachment],
            );
            api::send_upload(token, thread, message).await?
        }
    };
    let mid = sent["id"].as_str().unwrap_or_default().to_string();
    let inc = Incoming {
        user_id: user.to_string(),
        connector: ID,
        connection_id: Some(connection),
        thread: thread.to_string(),
        thread_title: None,
        external_id: mid.clone(),
        direction: Direction::Out,
        author: Author::Pigeon,
        sender: Some(account.clone()),
        sender_name: None,
        subject: subject.map(|s| if s.to_lowercase().starts_with("re:") { s } else { format!("Re: {s}") }),
        body,
        media,
        raw: json!({ "labels": ["SENT"], "to": [to], "cc": cc }),
        at: Utc::now(),
        counterpart: None,
        window: None,
        triage: false,
    };
    items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?;
    Ok(json!({ "sent": true, "to": to, "cc": cc, "message_id": mid, "thread": thread }))
}

/// Reply all: everyone their email went to or copied, but the user and who the reply is to.
fn reply_all_cc(raw: &Json, account: &str, to: &str) -> Vec<String> {
    let mut cc: Vec<String> = Vec::new();
    for key in ["to", "cc"] {
        for a in raw[key].as_array().into_iter().flatten().filter_map(Json::as_str) {
            let clean = a.contains('@') && !a.contains([',', ';', '<', '>', '\r', '\n', ' ']);
            let skip = a.eq_ignore_ascii_case(account) || a.eq_ignore_ascii_case(to) || cc.iter().any(|c| c.eq_ignore_ascii_case(a));
            if clean && !skip {
                cc.push(a.to_string());
            }
        }
    }
    cc
}

/// Threads matching `q` (newest first, at most `max`), each brought in whole as history.
async fn gather_threads(st: &State, c: &Conn<'_>, q: &str, max: usize) -> anyhow::Result<usize> {
    let token = api::access_token(st, c.id).await?;
    let mut ids: Vec<String> = Vec::new();
    let mut page: Option<String> = None;
    while ids.len() < max {
        let mut params = vec![("q", q.to_string()), ("maxResults", (max - ids.len()).min(100).to_string())];
        if let Some(p) = &page {
            params.push(("pageToken", p.clone()));
        }
        let res = api::gmail_ok(&token, "GET", "/threads", &params, None).await?;
        ids.extend(res["threads"].as_array().into_iter().flatten().filter_map(|t| t["id"].as_str().map(String::from)));
        page = res["nextPageToken"].as_str().map(String::from);
        if page.is_none() {
            break;
        }
    }
    let mut n = 0;
    for tid in ids.iter().take(max) {
        let thread = match api::gmail(&token, "GET", &format!("/threads/{tid}"), &[("format", "full".to_string())], None).await? {
            Got::Ok(v) => v,
            Got::NotFound => continue,
        };
        for msg in thread["messages"].as_array().into_iter().flatten() {
            match store(st, c, msg, false).await {
                Ok(true) => n += 1,
                Ok(false) => {}
                Err(e) => log::warn!("gmail {}: thread {tid}: {e:#}", c.account),
            }
        }
    }
    Ok(n)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reply_all_copies_everyone_else() {
        let raw = json!({ "to": ["me@gmail.com", "luca@x.com"], "cc": ["Boss@x.com", "marco@x.com", "luca@x.com", "bad,addr@x.com"] });
        assert_eq!(reply_all_cc(&raw, "me@gmail.com", "marco@x.com"), vec!["luca@x.com".to_string(), "Boss@x.com".to_string()]);
        assert!(reply_all_cc(&json!({ "to": ["me@gmail.com"] }), "me@gmail.com", "marco@x.com").is_empty());
    }
}

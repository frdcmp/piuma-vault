//! instagram: the user's Instagram DMs (a professional account: Creator or Business), through
//! Meta's Instagram API with Unified Login (the only one Meta offers new apps): the app belongs to
//! a business portfolio and has a login configuration (`PIGEON_INSTAGRAM_CONFIG_ID`). Connected by
//! a one-time link (Facebook Login for Business: they log in with Instagram or Facebook, pick the
//! portfolio and the account); the Business Integration System User token it gives is encrypted
//! in `db_pigeon_connections` (it doesn't expire unless the configuration says so; when Meta refuses it the
//! account is marked to connect again), `settings` holds the account's ids. Calls go to
//! graph.facebook.com/<the account's id>. In: Meta pushes each message to
//! `/pigeon/webhooks/instagram` (signed with the app secret): theirs as items to triage, the
//! user's own from the phone (echoes) as theirs.
//! Out: a reply, within Instagram's 24-hour window after their last message. The API can't
//! archive, delete or mark a DM read. `gather` brings recent conversations in as history (Meta
//! gives the 20 latest messages of each).

pub mod api;

use std::collections::HashMap;
use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeZone, Utc};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::connectors::{need_str, ActionDef, Connector, Kind};
use crate::apps::pigeon::items::{self, Author, Direction, Incoming};
use crate::apps::pigeon::sign;
use crate::apps::shares::crypto;
use crate::apps::pigeon::state::{AppState, State};

pub struct Instagram;

pub const ID: &str = "instagram";
/// Instagram's standard messaging window after the person's last message.
const WINDOW: Duration = Duration::from_secs(24 * 3600);
/// A message's text is 1000 bytes at most.
const MAX_TEXT: usize = 1000;
/// Meta gives the details of a conversation's latest 20 messages only.
const MESSAGES_PER_CONVERSATION: usize = 20;

/// One message event from a webhook delivery.
#[derive(Debug, Clone, PartialEq)]
pub struct Event {
    /// the professional account it's on (the entry's id)
    pub account: String,
    /// the other person's IGSID
    pub other: String,
    /// sent by the user (an echo: from their phone, or by Pigeon)
    pub mine: bool,
    pub mid: String,
    pub text: String,
    pub attachments: Vec<Json>,
    /// milliseconds since the epoch
    pub at_ms: i64,
}

/// The message events of a delivery; the rest (reads, reactions, deletions, edits) are counted
/// and left.
pub fn events(body: &Json) -> (Vec<Event>, usize) {
    let mut out = Vec::new();
    let mut other_events = 0;
    if body["object"].as_str() != Some("instagram") {
        return (out, 0);
    }
    for entry in body["entry"].as_array().into_iter().flatten() {
        let account = entry["id"].as_str().map(str::to_string).or_else(|| entry["id"].as_u64().map(|n| n.to_string())).unwrap_or_default();
        for m in entry["messaging"].as_array().into_iter().flatten() {
            let msg = &m["message"];
            let (Some(mid), false) = (msg["mid"].as_str(), msg["is_deleted"].as_bool().unwrap_or(false)) else {
                other_events += 1;
                continue;
            };
            let mine = msg["is_echo"].as_bool().unwrap_or(false);
            let (sender, recipient) = (m["sender"]["id"].as_str().unwrap_or_default(), m["recipient"]["id"].as_str().unwrap_or_default());
            let other = if mine { recipient } else { sender };
            if other.is_empty() {
                other_events += 1;
                continue;
            }
            out.push(Event {
                account: account.clone(),
                other: other.to_string(),
                mine,
                mid: mid.to_string(),
                text: msg["text"].as_str().unwrap_or_default().to_string(),
                attachments: msg["attachments"].as_array().cloned().unwrap_or_default(),
                at_ms: m["timestamp"].as_i64().unwrap_or_else(|| Utc::now().timestamp_millis()),
            });
        }
    }
    (out, other_events)
}

/// A message's text as an item's body: the text, and what's attached.
fn body_of(text: &str, attachments: &[Json]) -> String {
    let mut parts: Vec<String> = Vec::new();
    if !text.trim().is_empty() {
        parts.push(text.to_string());
    }
    for a in attachments {
        let kind = a["type"].as_str().unwrap_or("attachment");
        match a["payload"]["url"].as_str() {
            Some(u) => parts.push(format!("[{kind}: {u}]")),
            None => parts.push(format!("[{kind}]")),
        }
    }
    parts.join("\n")
}

/// The connection of a professional account, by its id (the webhook's entry id), and whose.
async fn connection_of(st: &State, account_id: &str) -> anyhow::Result<Option<(i32, String)>> {
    Ok(sqlx::query_as(
        "SELECT id, user_id FROM db_pigeon_connections WHERE connector = $1 AND status <> 'disconnected' AND settings->>'ig_user_id' = $2",
    )
    .bind(ID)
    .bind(account_id)
    .fetch_optional(&st.pool)
    .await?)
}

/// The person's name for an IGSID: the one Pigeon has, else the profile API's (name, or
/// @username). None when Meta won't say (no consent yet, blocked).
async fn name_of(st: &State, user: &str, token: &api::Token, igsid: &str) -> Option<String> {
    let known: Option<String> =
        sqlx::query_scalar("SELECT display_name FROM db_pigeon_contact_handles WHERE user_id = $1 AND connector = $2 AND handle = $3")
            .bind(user)
            .bind(ID)
            .bind(igsid)
        .fetch_optional(&st.pool)
        .await
        .ok()
        .flatten()
        .flatten();
    if known.is_some() {
        return known;
    }
    match api::graph(token, "GET", &format!("/{igsid}"), &[("fields", "name,username".to_string())], None).await {
        Ok(p) => {
            let username = p["username"].as_str().map(|u| format!("@{u}"));
            match (p["name"].as_str().filter(|n| !n.trim().is_empty()), username) {
                (Some(n), Some(u)) => Some(format!("{n} ({u})")),
                (Some(n), None) => Some(n.to_string()),
                (None, u) => u,
            }
        }
        Err(e) => {
            log::debug!("instagram: profile of {igsid}: {e:#}");
            None
        }
    }
}

/// Meta echoes every message the account sends, Pigeon's own too, and the echo's mid needn't be
/// the send's message_id: a message of Pigeon's in that conversation in the last minutes with the
/// same text is the one echoed (else the user would seem to have written, and auto replies hold).
const ECHO_WITHIN: &str = "10 minutes";

async fn pigeon_sent(st: &State, user: &str, other: &str, body: &str) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.user_id = $4 AND c.connector = $1 AND c.external_id = $2 AND i.author = 'pigeon' AND i.body = $3
            AND i.at > NOW() - INTERVAL '{ECHO_WITHIN}')"
    ))
    .bind(ID)
    .bind(other)
    .bind(body)
    .bind(user)
    .fetch_one(&st.pool)
    .await?)
}

/// One message as an item: its conversation, None when stored already.
#[allow(clippy::too_many_arguments)]
async fn store(
    st: &State,
    user: &str,
    connection: i32,
    my_id: &str,
    other: &str,
    name: Option<String>,
    mine: bool,
    mid: &str,
    body: String,
    attachments: Vec<Json>,
    at: DateTime<Utc>,
    triage: bool,
) -> anyhow::Result<Option<Uuid>> {
    if mine && pigeon_sent(st, user, other, &body).await? {
        return Ok(None);
    }
    let inc = Incoming {
        user_id: user.to_string(),
        connector: ID,
        connection_id: Some(connection),
        thread: other.to_string(),
        thread_title: name.clone(),
        external_id: mid.to_string(),
        direction: if mine { Direction::Out } else { Direction::In },
        author: if mine { Author::Me } else { Author::Them },
        sender: Some(if mine { my_id.to_string() } else { other.to_string() }),
        sender_name: if mine { None } else { name.clone() },
        subject: None,
        body,
        media: Json::Array(attachments),
        raw: json!({ "mid": mid }),
        at,
        counterpart: Some((other.to_string(), name)),
        window: (!mine).then_some(WINDOW),
        triage,
    };
    Ok(items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?.map(|i| i.conversation_id))
}

async fn take_in(st: &State, events: Vec<Event>) {
    for e in events {
        let r: anyhow::Result<()> = async {
            let Some((connection, user)) = connection_of(st, &e.account).await? else {
                log::warn!("instagram: a message for account {} that isn't connected", e.account);
                return Ok(());
            };
            let token = api::token(st, connection).await?;
            let name = name_of(st, &user, &token, &e.other).await;
            let at = Utc.timestamp_millis_opt(e.at_ms).single().unwrap_or_else(Utc::now);
            store(st, &user, connection, &e.account, &e.other, name, e.mine, &e.mid, body_of(&e.text, &e.attachments), e.attachments.clone(), at, true).await?;
            Ok(())
        }
        .await;
        if let Err(err) = r {
            log::warn!("instagram: message {}: {err:#}", e.mid);
            if let Ok(Some((connection, _))) = connection_of(st, &e.account).await {
                note_dead_token(st, connection, &err).await;
            }
        }
    }
}

/// The account's id on graph.facebook.com: every call's path.
async fn ig_id(st: &State, connection: i32) -> anyhow::Result<String> {
    sqlx::query_scalar::<_, Option<String>>("SELECT settings->>'ig_user_id' FROM db_pigeon_connections WHERE id = $1")
        .bind(connection)
        .fetch_one(&st.pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("the Instagram account has no id: connect it again"))
}

/// Meta refused the account's token: mark the account to be connected again.
async fn note_dead_token(st: &State, connection: i32, e: &anyhow::Error) {
    if !api::token_dead(e) {
        return;
    }
    let r = sqlx::query("UPDATE db_pigeon_connections SET status = 'error', last_error = $2, updated_at = NOW() WHERE id = $1")
        .bind(connection)
        .bind(format!("{e:#}: connect the account again"))
        .execute(&st.pool)
        .await;
    if let Err(db) = r {
        log::warn!("instagram: marking connection {connection}: {db:#}");
    }
}

/// A conversation's latest messages (up to 20) stored as history, in one request: a development-mode
/// app has few requests an hour, not one per message.
async fn gather_conversation(st: &State, user: &str, connection: i32, token: &api::Token, my_id: &str, cid: &str) -> anyhow::Result<usize> {
    let fields = format!("messages.limit({MESSAGES_PER_CONVERSATION}){{id,created_time,from,to,message}}");
    let conv = api::graph(token, "GET", &format!("/{cid}"), &[("fields", fields)], None).await?;
    let mut n = 0;
    for d in conv["messages"]["data"].as_array().into_iter().flatten().take(MESSAGES_PER_CONVERSATION) {
        let Some(mid) = d["id"].as_str() else { continue };
        let from = d["from"]["id"].as_str().unwrap_or_default();
        let mine = from == my_id;
        let (other, name) = if mine {
            let to = &d["to"]["data"][0];
            (to["id"].as_str().unwrap_or_default().to_string(), to["username"].as_str().map(|u| format!("@{u}")))
        } else {
            (from.to_string(), d["from"]["username"].as_str().map(|u| format!("@{u}")))
        };
        if other.is_empty() {
            continue;
        }
        let at = d["created_time"]
            .as_str()
            .and_then(|t| DateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%z").ok())
            .map(|t| t.with_timezone(&Utc))
            .unwrap_or_else(Utc::now);
        let name = name_of(st, user, token, &other).await.or(name);
        let text = d["message"].as_str().unwrap_or_default();
        let body = if text.trim().is_empty() { "[attachment]".to_string() } else { text.to_string() };
        if store(st, user, connection, my_id, &other, name, mine, mid, body, Vec::new(), at, false).await?.is_some() {
            n += 1;
        }
    }
    Ok(n)
}

#[async_trait]
impl Connector for Instagram {
    fn id(&self) -> &'static str {
        ID
    }

    fn title(&self) -> &'static str {
        "Instagram"
    }

    fn available(&self, st: &State) -> Result<(), String> {
        st.cfg.instagram.as_ref().map(|_| ()).ok_or_else(|| "PIGEON_INSTAGRAM_APP_ID, PIGEON_INSTAGRAM_APP_SECRET and PIGEON_INSTAGRAM_CONFIG_ID are not set".into())
    }

    fn actions(&self) -> Vec<ActionDef> {
        vec![ActionDef {
            name: "send_reply",
            kind: Kind::Reply,
            description: "Reply in this Instagram conversation, from the user's account (within 24 hours of their last message; 1000 bytes at most).",
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
            anyhow::bail!("instagram has no action '{action}'");
        }
        let conv = conversation.ok_or_else(|| anyhow::anyhow!("needs a conversation"))?;
        let (other, connection, window): (String, Option<i32>, Option<DateTime<Utc>>) = sqlx::query_as(
            "SELECT external_id, connection_id, window_until FROM db_pigeon_conversations WHERE id = $1 AND connector = $2 AND user_id = $3",
        )
                .bind(conv)
                .bind(ID)
                .bind(user)
                .fetch_optional(&st.pool)
                .await?
                .ok_or_else(|| anyhow::anyhow!("{conv} is not an Instagram conversation"))?;
        let connection = connection.ok_or_else(|| anyhow::anyhow!("the conversation has no Instagram account"))?;
        if window.is_none_or(|w| w < Utc::now()) {
            anyhow::bail!("Instagram's 24-hour reply window is closed: they have to write again first");
        }
        let text = need_str(args, "text")?;
        if text.len() > MAX_TEXT {
            anyhow::bail!("the reply is {} bytes; Instagram takes {MAX_TEXT} at most", text.len());
        }
        let token = api::token(st, connection).await?;
        let my_id = ig_id(st, connection).await?;
        let message = json!({ "recipient": { "id": other }, "message": { "text": text } });
        let sent = match api::graph(&token, "POST", &format!("/{my_id}/messages"), &[], Some(&message)).await {
            Ok(s) => s,
            Err(e) => {
                note_dead_token(st, connection, &e).await;
                return Err(e);
            }
        };
        let mid = sent["message_id"].as_str().unwrap_or_default().to_string();
        let inc = Incoming {
            user_id: user.to_string(),
            connector: ID,
            connection_id: Some(connection),
            thread: other.clone(),
            thread_title: None,
            external_id: mid.clone(),
            direction: Direction::Out,
            author: Author::Pigeon,
            sender: Some(my_id),
            sender_name: None,
            subject: None,
            body: text.to_string(),
            media: json!([]),
            raw: json!({ "mid": mid }),
            at: Utc::now(),
            counterpart: None,
            window: None,
            triage: false,
        };
        // its echo may have come in first, as the user's: it becomes Pigeon's
        let echoed = sqlx::query(&format!(
            "UPDATE db_pigeon_items i SET author = 'pigeon' FROM db_pigeon_conversations c
              WHERE c.id = i.conversation_id AND c.user_id = $4 AND c.connector = $1 AND c.external_id = $2 AND i.author = 'me' AND i.body = $3
                AND i.at > NOW() - INTERVAL '{ECHO_WITHIN}'"
        ))
        .bind(ID)
        .bind(&other)
        .bind(text)
        .bind(user)
        .execute(&st.pool)
        .await?
        .rows_affected();
        if echoed == 0 {
            items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?;
        }
        Ok(json!({ "sent": true, "to": other, "message_id": mid }))
    }

    fn shows_typing(&self) -> bool {
        true
    }

    async fn typing(&self, st: &State, conversation: Uuid, on: bool) -> anyhow::Result<()> {
        let (other, connection): (String, Option<i32>) =
            sqlx::query_as("SELECT external_id, connection_id FROM db_pigeon_conversations WHERE id = $1 AND connector = $2")
                .bind(conversation)
                .bind(ID)
                .fetch_optional(&st.pool)
                .await?
                .ok_or_else(|| anyhow::anyhow!("{conversation} is not an Instagram conversation"))?;
        let connection = connection.ok_or_else(|| anyhow::anyhow!("the conversation has no Instagram account"))?;
        let token = api::token(st, connection).await?;
        let my_id = ig_id(st, connection).await?;
        // Instagram takes the indicator off by itself after about 20 s, or when the message goes
        let action = json!({ "recipient": { "id": other }, "sender_action": if on { "typing_on" } else { "typing_off" } });
        api::graph(&token, "POST", &format!("/{my_id}/messages"), &[], Some(&action)).await?;
        Ok(())
    }

    async fn health(&self, st: &State, user: &str) -> Json {
        if let Err(e) = self.available(st) {
            return json!({ "available": false, "why": e });
        }
        let rows: Vec<(String, String, Option<DateTime<Utc>>, Option<String>, Json)> = sqlx::query_as(
            "SELECT account, status, last_ok_at, last_error, settings FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 ORDER BY account",
        )
        .bind(ID)
        .bind(user)
        .fetch_all(&st.pool)
        .await
        .unwrap_or_default();
        let accounts: Vec<Json> = rows
            .into_iter()
            .map(|(account, status, last_ok_at, last_error, settings)| {
                let expires = settings["token_expires_at"].as_i64().and_then(|t| Utc.timestamp_opt(t, 0).single());
                json!({ "account": account, "status": status, "last_ok_at": last_ok_at, "last_error": last_error, "token_expires_at": expires })
            })
            .collect();
        let webhook = st.cfg.instagram.as_ref().is_some_and(|c| c.verify_token.is_some());
        json!({
            "available": true,
            "accounts": accounts,
            "webhook": format!("{}/pigeon/webhooks/instagram", st.cfg.api_url()),
            "webhook_verify_token_set": webhook,
        })
    }

    fn connects_by_link(&self) -> bool {
        true
    }

    async fn connect_start(&self, st: &State, token: &str) -> anyhow::Result<String> {
        let c = st.cfg.instagram.as_ref().ok_or_else(|| anyhow::anyhow!("Instagram is not configured"))?;
        Ok(api::login_url(c, &api::redirect_uri(st), token))
    }

    async fn connect_finish(&self, st: &State, user: &str, query: &HashMap<String, String>) -> anyhow::Result<String> {
        if let Some(e) = query.get("error") {
            anyhow::bail!("Meta said: {e} {}", query.get("error_description").or(query.get("error_reason")).map(String::as_str).unwrap_or(""));
        }
        let code = query.get("code").ok_or_else(|| anyhow::anyhow!("Meta sent no code"))?;
        let c = st.cfg.instagram.as_ref().ok_or_else(|| anyhow::anyhow!("Instagram is not configured"))?;
        let (access, expires_in) = api::exchange(st, c, code).await?;
        let token = api::Token::new(c, access);
        // the token's user is the portfolio's system user; the accounts are the ones shared with the app
        let me = api::graph(&token, "GET", "/me", &[("fields", "client_business_id".to_string())], None).await?;
        let business = me["client_business_id"].as_str().unwrap_or_default().to_string();
        let assigned = api::graph(&token, "GET", "/me/assigned_instagram_accounts", &[("fields", "id,username".to_string())], None).await?;
        let id_of = |v: &Json| v.as_str().map(str::to_string).or_else(|| v.as_u64().map(|n| n.to_string()));
        let now = Utc::now().timestamp();
        let sealed = crypto::encrypt(&st.pool, &json!({ "access_token": token.access, "obtained_at": now }).to_string()).await.map_err(|e| anyhow::anyhow!(e))?;
        let mut connected = Vec::new();
        for a in assigned["data"].as_array().into_iter().flatten() {
            let (Some(ig_user_id), Some(username)) = (id_of(&a["id"]), a["username"].as_str()) else { continue };
            let username = username.to_lowercase();
            let mut settings = json!({ "ig_user_id": ig_user_id, "username": username, "client_business_id": business });
            if let Some(s) = expires_in {
                settings["token_expires_at"] = json!(now + s);
            }
            let account = format!("@{username}");
            // an account is one user's: connected by someone else already, it's left
            let id: Option<i32> = sqlx::query_scalar(
                "INSERT INTO db_pigeon_connections (user_id, connector, account, status, settings, secret, last_ok_at, last_error)
                 VALUES ($5, $1, $2, 'connected', $3, $4, NOW(), NULL)
                 ON CONFLICT (connector, account) DO UPDATE
                   SET status = 'connected', settings = EXCLUDED.settings, secret = EXCLUDED.secret, last_ok_at = NOW(), last_error = NULL, updated_at = NOW()
                   WHERE db_pigeon_connections.user_id = EXCLUDED.user_id
                 RETURNING id",
            )
            .bind(ID)
            .bind(&account)
            .bind(&settings)
            .bind(&sealed)
            .bind(user)
            .fetch_optional(&st.pool)
            .await?;
            let Some(id) = id else {
                log::warn!("instagram {account}: connected by another user, left");
                continue;
            };
            // messages pushed to the webhook from now on
            let subscribe = api::graph(&token, "POST", &format!("/{ig_user_id}/subscribed_apps"), &[("subscribed_fields", "messages".to_string())], None).await;
            if let Err(e) = subscribe {
                log::warn!("instagram {account}: subscribing to messages: {e:#}");
                sqlx::query("UPDATE db_pigeon_connections SET last_error = $2 WHERE id = $1").bind(id).bind(format!("subscribing to messages: {e:#}")).execute(&st.pool).await?;
            }
            connected.push(account);
        }
        if connected.is_empty() {
            anyhow::bail!("no Instagram account was shared with the app: connect again and pick the account (a professional one, in the business portfolio)");
        }
        Ok(connected.join(", "))
    }

    fn webhook_verify(&self, st: &State, query: &HashMap<String, String>) -> Option<String> {
        let want = st.cfg.instagram.as_ref()?.verify_token.as_deref()?;
        let ok = query.get("hub.mode").map(String::as_str) == Some("subscribe")
            && query.get("hub.verify_token").is_some_and(|t| sign::sha256(t) == sign::sha256(want));
        if ok {
            query.get("hub.challenge").cloned()
        } else {
            None
        }
    }

    async fn webhook(&self, st: &AppState, signature: Option<&str>, body: &[u8]) -> anyhow::Result<bool> {
        let c = st.cfg.instagram.as_ref().ok_or_else(|| anyhow::anyhow!("Instagram is not configured"))?;
        if !api::signature_ok(&c.app_secret, body, signature) {
            return Ok(false);
        }
        let payload: Json = serde_json::from_slice(body)?;
        let (evs, other_events) = events(&payload);
        if other_events > 0 {
            log::debug!("instagram: {other_events} event(s) that aren't messages, left");
        }
        if !evs.is_empty() {
            let st = st.clone();
            tokio::spawn(async move { take_in(&st, evs).await });
        }
        Ok(true)
    }

    async fn gather(&self, st: &State, user: &str, handle: Option<&str>, days: i64, max_threads: usize) -> anyhow::Result<usize> {
        let accounts: Vec<(i32, Json)> =
            sqlx::query_as("SELECT id, settings FROM db_pigeon_connections WHERE connector = $1 AND user_id = $2 AND status <> 'disconnected' ORDER BY id")
                .bind(ID)
                .bind(user)
                .fetch_all(&st.pool)
                .await?;
        let since = Utc::now() - chrono::Duration::days(days);
        let mut n = 0;
        for (connection, settings) in accounts {
            let Some(my_id) = settings["ig_user_id"].as_str().filter(|s| !s.is_empty()) else { continue };
            let token = api::token(st, connection).await?;
            let mut q = vec![("platform", "instagram".to_string())];
            if let Some(h) = handle {
                if !h.chars().all(|c| c.is_ascii_digit()) {
                    anyhow::bail!("{h} is not an Instagram-scoped id");
                }
                q.push(("user_id", h.to_string()));
            }
            let list = match api::graph(&token, "GET", &format!("/{my_id}/conversations"), &q, None).await {
                Ok(l) => l,
                Err(e) => {
                    note_dead_token(st, connection, &e).await;
                    return Err(e);
                }
            };
            for conv in list["data"].as_array().into_iter().flatten().take(max_threads) {
                let Some(cid) = conv["id"].as_str() else { continue };
                // updated_time: the latest message's time (a UNIX time, or an ISO one)
                let updated = conv["updated_time"]
                    .as_i64()
                    .and_then(|t| Utc.timestamp_opt(t, 0).single())
                    .or_else(|| conv["updated_time"].as_str().and_then(|t| DateTime::parse_from_str(t, "%Y-%m-%dT%H:%M:%S%z").ok()).map(|t| t.with_timezone(&Utc)));
                if updated.is_some_and(|u| u < since) {
                    continue;
                }
                match gather_conversation(st, user, connection, &token, my_id, cid).await {
                    Ok(k) => n += k,
                    Err(e) if api::rate_limited(&e) => {
                        log::warn!("instagram: Meta's request limit reached, stopping with {n} message(s) in: {e:#}");
                        return Ok(n);
                    }
                    Err(e) => log::warn!("instagram: conversation {cid}: {e:#}"),
                }
            }
        }
        Ok(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_delivery_gives_its_messages() {
        let body = json!({
            "object": "instagram",
            "entry": [{
                "id": "17841400000000001",
                "time": 1793548800,
                "messaging": [
                    { "sender": { "id": "900" }, "recipient": { "id": "17841400000000001" }, "timestamp": 1793548800123_i64,
                      "message": { "mid": "m1", "text": "Ciao! come stai?" } },
                    { "sender": { "id": "17841400000000001" }, "recipient": { "id": "900" }, "timestamp": 1793548900000_i64,
                      "message": { "mid": "m2", "text": "bene!", "is_echo": true } },
                    { "sender": { "id": "900" }, "recipient": { "id": "17841400000000001" }, "timestamp": 1793549000000_i64,
                      "message": { "mid": "m3", "attachments": [{ "type": "image", "payload": { "url": "https://x/y.jpg" } }] } },
                    { "sender": { "id": "900" }, "recipient": { "id": "17841400000000001" }, "timestamp": 1,
                      "message": { "mid": "m4", "is_deleted": true } },
                    { "sender": { "id": "900" }, "recipient": { "id": "17841400000000001" }, "timestamp": 1, "read": { "mid": "m2" } },
                    { "sender": { "id": "900" }, "recipient": { "id": "17841400000000001" }, "timestamp": 1,
                      "reaction": { "mid": "m2", "action": "react", "reaction": "love" } }
                ]
            }]
        });
        let (evs, other) = events(&body);
        assert_eq!(other, 3, "deleted, read, reaction");
        assert_eq!(evs.len(), 3);
        assert_eq!((evs[0].other.as_str(), evs[0].mine, evs[0].text.as_str()), ("900", false, "Ciao! come stai?"));
        assert_eq!(evs[0].account, "17841400000000001");
        assert_eq!((evs[1].other.as_str(), evs[1].mine), ("900", true), "an echo is the user's, with them");
        assert_eq!(body_of(&evs[2].text, &evs[2].attachments), "[image: https://x/y.jpg]");
        assert!(events(&json!({ "object": "page", "entry": [] })).0.is_empty(), "not Instagram's");
    }
}

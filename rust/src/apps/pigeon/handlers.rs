//! The Inbox's API (`/admin/pigeon/…`): the chats, their messages and cards, the user's own
//! messages, the switches, people, rules, settings and connections. Reading needs `inbox.read`,
//! changing `inbox.write` (`admin_access` holds both). Everything is the signed-in user's own.

use actix_web::{dev::Payload, web, FromRequest, HttpRequest, HttpResponse};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::auth::access::{gated, GateFuture};
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::auth::middleware::check_permission;
use crate::apps::pigeon::ai::llm;
use crate::apps::pigeon::connectors::{console, Kind};
use crate::apps::pigeon::policy::{self, Policy};
use crate::apps::pigeon::state::AppState;
use crate::apps::pigeon::{actions, agent, alerts, avatars, cards, connect, conversations, events, items, media, people, rules, tools, triage};
use crate::apps::settings::store;

pub struct InboxReader(pub AuthenticatedUser);
pub struct InboxWriter(pub AuthenticatedUser);

impl FromRequest for InboxReader {
    type Error = actix_web::Error;
    type Future = GateFuture<Self>;
    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, "inbox.read", InboxReader)
    }
}

impl FromRequest for InboxWriter {
    type Error = actix_web::Error;
    type Future = GateFuture<Self>;
    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, "inbox.write", InboxWriter)
    }
}

fn fail(e: anyhow::Error) -> HttpResponse {
    HttpResponse::BadRequest().json(json!({ "error": format!("{e:#}") }))
}

fn reply(r: anyhow::Result<Json>) -> HttpResponse {
    match r {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => fail(e),
    }
}

// ── the chats ────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ListQuery {
    /// needs: only what needs the user (attention or cards)
    filter: Option<String>,
    connector: Option<String>,
    q: Option<String>,
    /// older than this (the list's last `last_item_at`), for the next page
    before: Option<DateTime<Utc>>,
    limit: Option<i64>,
}

/// The chat list, latest first: who, the channel, a preview, unread, and how many cards wait.
pub async fn list_conversations(st: web::Data<AppState>, u: InboxReader, q: web::Query<ListQuery>) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        #[allow(clippy::type_complexity)]
        let rows: Vec<(Uuid, String, Option<String>, Option<Uuid>, Option<String>, Option<String>, Option<DateTime<Utc>>, Option<String>, Option<String>, Option<String>, bool, i64)> =
            sqlx::query_as(
                "SELECT c.id, c.connector, c.title, c.contact_id, ct.name, ct.slug, c.last_item_at, c.attention,
                        (SELECT i.body FROM db_pigeon_items i WHERE i.conversation_id = c.id ORDER BY i.at DESC LIMIT 1),
                        (SELECT i.author FROM db_pigeon_items i WHERE i.conversation_id = c.id ORDER BY i.at DESC LIMIT 1),
                        c.last_in_at IS NOT NULL AND c.last_in_at > COALESCE(c.read_at, '-infinity'::timestamptz) AS unread,
                        (SELECT COUNT(*) FROM db_pigeon_actions a WHERE a.conversation_id = c.id AND a.status = 'pending')
                      + (SELECT COUNT(*) FROM db_pigeon_questions q WHERE q.conversation_id = c.id AND q.status = 'open')
                      + (SELECT COUNT(*) FROM db_pigeon_rule_runs r WHERE r.conversation_id = c.id AND r.status = 'pending')
                      + (SELECT COUNT(*) FROM db_pigeon_confirmations f WHERE f.conversation_id = c.id AND f.status = 'pending')
                      + (CASE WHEN c.needs_note IS NULL THEN 0 ELSE 1 END) AS cards
                   FROM db_pigeon_conversations c LEFT JOIN db_pigeon_contacts ct ON ct.id = c.contact_id
                  WHERE c.user_id = $1 AND c.last_item_at IS NOT NULL
                    AND ($2::text IS NULL OR c.connector = $2)
                    AND ($3::timestamptz IS NULL OR c.last_item_at < $3)
                    AND ($4::text IS NULL OR ct.name ILIKE '%' || $4 || '%' OR c.title ILIKE '%' || $4 || '%' OR ct.slug = lower(ltrim($4, '@')))
                  ORDER BY c.last_item_at DESC LIMIT $5",
            )
            .bind(user)
            .bind(q.connector.as_deref().filter(|c| !c.is_empty()))
            .bind(q.before)
            .bind(q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()))
            .bind(q.limit.unwrap_or(50).clamp(1, 200))
            .fetch_all(&st.pool)
            .await?;
        let needs = q.filter.as_deref() == Some("needs");
        let out: Vec<Json> = rows
            .into_iter()
            .filter(|r| !needs || r.7.is_some() || r.11 > 0)
            .map(|(id, connector, title, contact_id, name, slug, last, attention, body, author, unread, cards)| {
                json!({
                    "id": id, "connector": connector, "title": title, "contact_id": contact_id,
                    "with": name.clone().or_else(|| slug.as_ref().map(|s| format!("@{s}"))).or(title.clone()).unwrap_or_else(|| "someone".into()), "slug": slug,
                    "last_item_at": last, "attention": attention,
                    "preview": body.map(|b| conversations::clip(&b, 120)), "last_author": author,
                    "unread": unread, "cards": cards,
                })
            })
            .collect();
        Ok(json!({ "conversations": out }))
    }
    .await;
    reply(r)
}

/// One chat: the conversation, the person, its switches and the cards waiting.
pub async fn get_conversation(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        let conv = tools::own_conversation(&st, user, id).await?;
        let contact = conversations::contact(&st.pool, conv.contact_id).await?;
        let reply_policy = policy::resolve(&st.pool, user, Kind::Reply, conv.contact_id, Some(id)).await?;
        let own_reply: Option<String> = sqlx::query_scalar(
            "SELECT policy FROM db_pigeon_policies WHERE user_id = $1 AND scope = 'conversation' AND scope_id = $2 AND kind = 'reply'",
        )
        .bind(user)
        .bind(id.to_string())
        .fetch_optional(&st.pool)
        .await?;
        let own_alerts: Option<String> = sqlx::query_scalar("SELECT level FROM db_pigeon_alert_levels WHERE user_id = $1 AND conversation_id = $2")
            .bind(user)
            .bind(id)
            .fetch_optional(&st.pool)
            .await?;
        let (avatar, avatar_photo) = avatars::Links::new(&st.pool).await.of(&st.pool, contact.as_ref().and_then(|c| c.avatar_key.as_deref())).await;
        Ok(json!({
            "conversation": conv,
            "with": conversations::who(contact.as_ref(), &conv),
            "avatar": avatar, "avatar_photo": avatar_photo,
            "contact": contact,
            "switches": {
                "reply": reply_policy.as_str(),
                "reply_own": own_reply,
                "alerts": alerts::resolve(&st.pool, user, conv.contact_id, Some(id)).await?.as_str(),
                "alerts_own": own_alerts,
                "auto_enabled": policy::auto_enabled(&st.pool, user).await?,
            },
            "cards": cards::list(&st, user, Some(id)).await?,
        }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct PageQuery {
    before: Option<DateTime<Utc>>,
    limit: Option<i64>,
}

/// A chat's messages and news, oldest first: the latest page, or the one before `before`.
pub async fn conversation_items(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>, q: web::Query<PageQuery>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        let conv = tools::own_conversation(&st, user, id).await?;
        let limit = q.limit.unwrap_or(50).clamp(1, 200);
        let mut items: Vec<conversations::Item> = sqlx::query_as(&format!(
            "SELECT {} FROM db_pigeon_items WHERE conversation_id = $1 AND ($2::timestamptz IS NULL OR at < $2) ORDER BY at DESC LIMIT $3",
            conversations::ITEM_COLS
        ))
        .bind(id)
        .bind(q.before)
        .bind(limit)
        .fetch_all(&st.pool)
        .await?;
        items.reverse();
        let more = items.len() as i64 == limit;
        // the news of the same stretch (all of it after the oldest message shown)
        let from = if more { items.first().map(|i| i.at) } else { None };
        let news: Vec<(i64, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, text, url, created_at FROM db_pigeon_news WHERE user_id = $1 AND conversation_id = $2
               AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4) ORDER BY created_at",
        )
        .bind(user)
        .bind(id)
        .bind(from)
        .bind(q.before)
        .fetch_all(&st.pool)
        .await?;
        // who wrote them, as the people Pigeon knows: a group's history gives numbers, not names
        let mut handles: Vec<String> = items.iter().filter(|i| i.direction == "in").filter_map(|i| i.sender.clone()).collect();
        handles.sort();
        handles.dedup();
        let people: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT h.handle, c.name, c.slug FROM db_pigeon_contact_handles h JOIN db_pigeon_contacts c ON c.id = h.contact_id
              WHERE h.user_id = $1 AND h.connector = $2 AND h.handle = ANY($3)",
        )
        .bind(user)
        .bind(&conv.connector)
        .bind(&handles)
        .fetch_all(&st.pool)
        .await?;
        let senders: serde_json::Map<String, Json> =
            people.into_iter().map(|(handle, name, slug)| (handle, json!({ "name": name, "slug": slug }))).collect();
        // their files, each with a link
        let mut items: Vec<Json> = items.iter().map(serde_json::to_value).collect::<Result<_, _>>()?;
        media::sign(&st.pool, &mut items).await;
        Ok(json!({
            "items": items,
            "senders": senders,
            "news": news.into_iter().map(|(id, text, url, at)| json!({ "id": id, "text": text, "url": url, "at": at })).collect::<Vec<_>>(),
            "more": more,
        }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct SendBody {
    text: String,
}

/// The user's own message, written in the Inbox: sent at once, as theirs.
pub async fn send(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<SendBody>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        let conv = tools::own_conversation(&st, user, id).await?;
        let text = body.text.trim();
        if text.is_empty() {
            anyhow::bail!("nothing to send");
        }
        let row = actions::direct(&st, user, &conv.connector, "send_reply", json!({ "text": text }), Some(id), "user (Inbox)").await?;
        if row.status != "done" {
            anyhow::bail!("{}", row.error.unwrap_or_else(|| format!("not sent ({})", row.status)));
        }
        // the connector stored it as Pigeon's: it's the user's
        let item: Option<Uuid> = sqlx::query_scalar(
            "SELECT i.id FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
              WHERE c.id = $1 AND c.user_id = $3 AND i.direction = 'out' AND i.author = 'pigeon' AND i.body = $2
                AND i.created_at > NOW() - INTERVAL '10 minutes'
              ORDER BY i.created_at DESC LIMIT 1",
        )
        .bind(id)
        .bind(text)
        .bind(user)
        .fetch_optional(&st.pool)
        .await?;
        if let Some(item) = item {
            items::mark_mine(&st.pool, item).await?;
        }
        Ok(actions::view(&row))
    }
    .await;
    reply(r)
}

/// The user opened the chat: what's in is read.
pub async fn mark_read(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        sqlx::query("UPDATE db_pigeon_conversations SET read_at = NOW() WHERE id = $1 AND user_id = $2").bind(id).bind(user).execute(&st.pool).await?;
        events::publish(&st.pool, user, "conversations", Some(id)).await;
        Ok(json!({ "read": id }))
    }
    .await;
    reply(r)
}

pub async fn mark_handled(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        tools::own_conversation(&st, user, id).await?;
        tools::mark_handled(&st, id).await?;
        Ok(json!({ "handled": id }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct DraftBody {
    instructions: Option<String>,
    /// the words back for the user's message box ({ text }), no card
    #[serde(default)]
    compose: bool,
}

/// Pigeon writes a reply now: a draft card, or (`compose`) the words for the user's own box.
pub async fn draft(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<DraftBody>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        tools::own_conversation(&st, user, id).await?;
        if body.compose {
            let text = agent::compose_reply(&st, id, body.instructions.as_deref())
                .await?
                .ok_or_else(|| anyhow::anyhow!("Pigeon wrote nothing this time: try again, or tell it what to say"))?;
            return Ok(json!({ "text": text }));
        }
        let out = agent::draft_reply(&st, id, body.instructions.as_deref()).await?;
        if !out.iter().any(|o| o.status == "pending") {
            anyhow::bail!("Pigeon wrote no draft this time: try again, or tell it what to say");
        }
        Ok(json!({ "drafted": out.len() }))
    }
    .await;
    reply(r)
}

/// What the conversation is about, written when stale.
pub async fn summary(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        let conv = tools::own_conversation(&st, user, id).await?;
        Ok(json!({ "summary": agent::summary(&st, &conv).await? }))
    }
    .await;
    reply(r)
}

/// A switch: a policy (off / ask / auto / inherit) or an alert level (all / smart / quiet / off /
/// inherit), set by the user's own tap.
#[derive(Deserialize)]
pub struct Switches {
    reply: Option<String>,
    alerts: Option<String>,
}

async fn set_switches(st: &AppState, user: &str, contact: Option<Uuid>, conversation: Option<Uuid>, s: &Switches) -> anyhow::Result<()> {
    let (scope, scope_id) = match (conversation, contact) {
        (Some(c), _) => ("conversation", c.to_string()),
        (None, Some(c)) => ("contact", c.to_string()),
        (None, None) => ("default", String::new()),
    };
    if let Some(p) = s.reply.as_deref() {
        let pol = if p == "inherit" { None } else { Some(Policy::parse(p).ok_or_else(|| anyhow::anyhow!("reply: off, ask, auto or inherit"))?) };
        tools::set_policy(st, user, Kind::Reply, pol, scope, &scope_id).await?;
    }
    if let Some(l) = s.alerts.as_deref() {
        let level = if l == "inherit" { None } else { Some(alerts::Level::parse(l).ok_or_else(|| anyhow::anyhow!("alerts: all, smart, quiet, off or inherit"))?) };
        alerts::set(&st.pool, user, contact.filter(|_| conversation.is_none()), conversation, level).await?;
    }
    match conversation {
        Some(c) => events::conversation(&st.pool, c).await,
        None => events::publish(&st.pool, user, "settings", None).await,
    }
    Ok(())
}

pub async fn conversation_switches(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<Switches>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        tools::own_conversation(&st, user, id).await?;
        set_switches(&st, user, None, Some(id), &body).await?;
        Ok(json!({ "ok": true }))
    }
    .await;
    reply(r)
}

/// General: what isn't about one chat (drafts of new emails, confirmations), and Pigeon's news.
pub async fn general(st: web::Data<AppState>, u: InboxReader, q: web::Query<PageQuery>) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        let news: Vec<(i64, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, text, url, created_at FROM db_pigeon_news WHERE user_id = $1 AND conversation_id IS NULL
               AND ($2::timestamptz IS NULL OR created_at < $2) ORDER BY created_at DESC LIMIT $3",
        )
        .bind(user)
        .bind(q.before)
        .bind(q.limit.unwrap_or(50).clamp(1, 200))
        .fetch_all(&st.pool)
        .await?;
        let mut news: Vec<Json> = news.into_iter().map(|(id, text, url, at)| json!({ "id": id, "text": text, "url": url, "at": at })).collect();
        news.reverse();
        Ok(json!({ "cards": cards::list(&st, user, None).await?, "news": news }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct PressBody {
    button: String,
    text: Option<String>,
}

/// A card's button (or its words sent).
pub async fn press(st: web::Data<AppState>, u: InboxWriter, path: web::Path<(String, Uuid)>, body: web::Json<PressBody>) -> HttpResponse {
    let user = &u.0.user_id;
    let (kind, id) = path.into_inner();
    match cards::press(&st, user, &kind, id, &body.button, body.text.as_deref()).await {
        Ok(said) => HttpResponse::Ok().json(json!({ "result": said })),
        Err(e) => fail(e),
    }
}

// ── people ───────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ContactsQuery {
    q: Option<String>,
    limit: Option<i64>,
}

pub async fn list_contacts(st: web::Data<AppState>, u: InboxReader, q: web::Query<ContactsQuery>) -> HttpResponse {
    reply(tools::contacts(&st, &u.0.user_id, q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()), q.limit.unwrap_or(100).clamp(1, 500)).await)
}

pub async fn get_contact(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>) -> HttpResponse {
    reply(people::view(&st, &u.0.user_id, path.into_inner()).await)
}

/// Create (no contact_id) or change a contact.
pub async fn set_contact(st: web::Data<AppState>, u: InboxWriter, body: web::Json<Json>) -> HttpResponse {
    let r: anyhow::Result<Json> = async {
        let input: people::ContactInput = serde_json::from_value(body.into_inner()).map_err(|e| anyhow::anyhow!("{e}"))?;
        let v = people::set_contact(&st, &u.0.user_id, input).await?;
        events::publish(&st.pool, &u.0.user_id, "conversations", None).await;
        Ok(v)
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct NoteBody {
    note: Option<String>,
}

pub async fn set_contact_note(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<NoteBody>) -> HttpResponse {
    let args = json!({ "contact_id": path.into_inner().to_string(), "note": body.note.clone().unwrap_or_default() });
    reply(tools::run(&st, &u.0.user_id, "pigeon_set_note", &args).await)
}

#[derive(Deserialize)]
pub struct MergeBody {
    merge_id: Uuid,
}

/// The user's own merge (in the Inbox: their tap is the yes).
pub async fn merge_contacts(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<MergeBody>) -> HttpResponse {
    let r = people::merge(&st, &u.0.user_id, path.into_inner(), body.merge_id).await;
    if r.is_ok() {
        events::publish(&st.pool, &u.0.user_id, "conversations", None).await;
    }
    reply(r)
}

pub async fn contact_switches(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<Switches>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        people::mine(&st, user, id).await?;
        set_switches(&st, user, Some(id), None, &body).await?;
        Ok(json!({ "ok": true }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct LearnBody {
    days: Option<i64>,
}

pub async fn learn_contact(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>, body: web::Json<LearnBody>) -> HttpResponse {
    reply(people::learn(&st, &u.0.user_id, path.into_inner(), body.days.unwrap_or(365).clamp(1, 3650)).await)
}

/// Everyone the user wrote to, learnt in the background.
pub async fn learn_all(st: web::Data<AppState>, u: InboxWriter, body: web::Json<LearnBody>) -> HttpResponse {
    let days = body.days.unwrap_or(90).clamp(1, 3650);
    let started = people::learn_all(st.get_ref().clone(), u.0.user_id.clone(), days);
    HttpResponse::Ok().json(json!({ "started": started, "days": days }))
}

/// An email as it was sent: `{ html }` (null when it has none).
pub async fn item_html(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>) -> HttpResponse {
    let r = crate::apps::pigeon::connectors::gmail::html_of(&st, &u.0.user_id, path.into_inner()).await;
    reply(r.map(|html| json!({ "html": html })))
}

#[derive(Deserialize)]
pub struct OnlyQuery {
    /// just this person
    contact_id: Option<Uuid>,
}

/// Names from the user's WhatsApp address book (people::import_whatsapp), for everyone or one.
pub async fn import_whatsapp(st: web::Data<AppState>, u: InboxWriter, q: web::Query<OnlyQuery>) -> HttpResponse {
    reply(people::import_whatsapp(&st, &u.0.user_id, q.contact_id).await)
}

// ── rules ────────────────────────────────────────────────────────────────

pub async fn list_rules(st: web::Data<AppState>, u: InboxReader) -> HttpResponse {
    reply(tools::run(&st, &u.0.user_id, "pigeon_rules", &json!({})).await)
}

/// Make or change a rule (the user's own: no confirmation).
pub async fn set_rule(st: web::Data<AppState>, u: InboxWriter, body: web::Json<Json>) -> HttpResponse {
    reply(tools::run(&st, &u.0.user_id, "pigeon_set_rule", &body).await)
}

pub async fn delete_rule(st: web::Data<AppState>, u: InboxWriter, path: web::Path<i32>) -> HttpResponse {
    reply(tools::run(&st, &u.0.user_id, "pigeon_delete_rule", &json!({ "rule_id": path.into_inner() })).await)
}

#[derive(Deserialize)]
pub struct TryBody {
    limit: Option<i64>,
    apply: Option<bool>,
}

pub async fn try_rule(st: web::Data<AppState>, u: InboxWriter, path: web::Path<i32>, body: web::Json<TryBody>) -> HttpResponse {
    let args = json!({ "rule_id": path.into_inner(), "limit": body.limit, "apply": body.apply.unwrap_or(false) });
    reply(tools::run(&st, &u.0.user_id, "pigeon_try_rule", &args).await)
}

pub async fn rule_runs(st: web::Data<AppState>, u: InboxReader, path: web::Path<i32>) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        let mut out = Vec::new();
        for run in rules::runs(&st, user, Some(path.into_inner()), None, 50).await? {
            out.push(rules::view(&st, &run).await?);
        }
        Ok(json!({ "runs": out }))
    }
    .await;
    reply(r)
}

// ── settings and connections ─────────────────────────────────────────────

/// The user's defaults (reply / record / organize, alerts), the auto switch, the model Pigeon
/// writes with, and the channels.
pub async fn get_settings(st: web::Data<AppState>, u: InboxReader) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        let mut defaults = serde_json::Map::new();
        for k in [Kind::Reply, Kind::Record, Kind::Organize] {
            defaults.insert(k.as_str().into(), json!(policy::resolve(&st.pool, user, k, None, None).await?.as_str()));
        }
        Ok(json!({
            "auto_enabled": policy::auto_enabled(&st.pool, user).await?,
            "defaults": defaults,
            "alerts": alerts::resolve(&st.pool, user, None, None).await?.as_str(),
            "media_days": media::keep_days(&st.pool, user).await?,
            "model_id": store::get(&st.pool, llm::MODEL_SETTING).await,
            "writer_available": llm::available(&st.pool).await,
            "jev_available": st.jev.is_some(),
            "console": st.cfg.console,
            "connectors": tools::connectors_view(&st, user).await?["connectors"],
        }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct SettingsBody {
    auto_enabled: Option<bool>,
    reply: Option<String>,
    record: Option<String>,
    organize: Option<String>,
    alerts: Option<String>,
    /// how long files are kept: 30, 90, 180 or 365 days
    media_days: Option<i64>,
    /// the model Pigeon writes with (a vault model's id; "" for the default): admins only
    model_id: Option<String>,
}

pub async fn set_settings(st: web::Data<AppState>, u: InboxWriter, body: web::Json<SettingsBody>) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        if let Some(on) = body.auto_enabled {
            policy::set_auto_enabled(&st.pool, user, on).await?;
        }
        for (k, v) in [(Kind::Reply, &body.reply), (Kind::Record, &body.record), (Kind::Organize, &body.organize)] {
            if let Some(p) = v.as_deref() {
                let pol = Policy::parse(p).ok_or_else(|| anyhow::anyhow!("{}: off, ask or auto", k.as_str()))?;
                tools::set_policy(&st, user, k, Some(pol), "default", "").await?;
            }
        }
        if let Some(l) = body.alerts.as_deref() {
            let level = alerts::Level::parse(l).ok_or_else(|| anyhow::anyhow!("alerts: all, smart, quiet or off"))?;
            alerts::set(&st.pool, user, None, None, Some(level)).await?;
        }
        if let Some(d) = body.media_days {
            media::set_keep_days(&st.pool, user, d).await?;
        }
        if let Some(m) = body.model_id.as_deref() {
            if !crate::apps::auth::middleware::check_permission(&u.0, "admin_access") {
                anyhow::bail!("only an admin picks the model Pigeon writes with");
            }
            store::set(&st.pool, llm::MODEL_SETTING, m.trim()).await.map_err(|e| anyhow::anyhow!("{e}"))?;
        }
        events::publish(&st.pool, user, "settings", None).await;
        Ok(json!({ "ok": true }))
    }
    .await;
    reply(r)
}

/// A one-time link to connect an account (opened in the browser).
pub async fn connect_link(st: web::Data<AppState>, u: InboxWriter, path: web::Path<String>) -> HttpResponse {
    match connect::link(&st, &u.0.user_id, &path.into_inner()).await {
        Ok(url) => HttpResponse::Ok().json(json!({ "url": url, "expires_in_minutes": 10 })),
        Err(e) => fail(e),
    }
}

/// Pairing with a code (WhatsApp's QR), polled by the settings.
pub async fn connect_pairing(st: web::Data<AppState>, u: InboxWriter, path: web::Path<String>) -> HttpResponse {
    reply(connect::pairing(&st, &u.0.user_id, &path.into_inner()).await)
}

pub async fn disconnect(st: web::Data<AppState>, u: InboxWriter, path: web::Path<i32>) -> HttpResponse {
    match connect::disconnect(&st, &u.0.user_id, path.into_inner()).await {
        Ok(()) => HttpResponse::Ok().json(json!({ "ok": true })),
        Err(e) => fail(e),
    }
}

/// The user's accounts, with their ids (to disconnect one).
pub async fn list_connections(st: web::Data<AppState>, u: InboxReader) -> HttpResponse {
    let r: anyhow::Result<Json> = async {
        let rows: Vec<(i32, String, String, String, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
            "SELECT id, connector, account, status, last_ok_at, last_error FROM db_pigeon_connections WHERE user_id = $1 AND status <> 'disconnected' ORDER BY connector, account",
        )
        .bind(&u.0.user_id)
        .fetch_all(&st.pool)
        .await?;
        Ok(json!({ "connections": rows.into_iter().map(|(id, connector, account, status, last_ok_at, last_error)| json!({
            "id": id, "connector": connector, "account": account, "status": status, "last_ok_at": last_ok_at, "last_error": last_error,
        })).collect::<Vec<_>>() }))
    }
    .await;
    reply(r)
}

// ── dev ──────────────────────────────────────────────────────────────────

#[derive(Deserialize)]
pub struct ConsoleBody {
    from: String,
    name: Option<String>,
    text: String,
    thread: Option<String>,
    #[serde(default)]
    as_me: bool,
    /// skip the debounce and triage at once
    #[serde(default)]
    triage_now: bool,
}

/// Dev (PIGEON_CONSOLE=1): a message on the console channel, as if someone sent it to the user
/// (or, with as_me, as if they wrote it). It is triaged like any other.
pub async fn console_receive(st: web::Data<AppState>, u: InboxWriter, body: web::Json<ConsoleBody>) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        if !st.cfg.console {
            anyhow::bail!("the console channel is off (PIGEON_CONSOLE=1)");
        }
        let conv = console::receive(&st, user, &body.from, body.name.as_deref(), &body.text, body.thread.as_deref(), body.as_me).await?;
        let mut out = json!({ "conversation_id": conv });
        if !body.as_me && body.triage_now {
            sqlx::query("UPDATE db_pigeon_conversations SET triage_due_at = NULL WHERE id = $1").bind(conv).execute(&st.pool).await?;
            triage::triage(&st, conv).await?;
            let c = conversations::get(&st.pool, conv).await?;
            out["attention"] = json!(c.as_ref().and_then(|c| c.attention.clone()));
            out["proposed"] = json!(actions::list(&st, user, None, Some(conv), 10).await?.iter().map(actions::view).collect::<Vec<_>>());
        }
        Ok(out)
    }
    .await;
    reply(r)
}

// ── chats by person ──────────────────────────────────────────────────────
//
// A person's chat is everything with them, on every channel: their threads (a WhatsApp chat,
// Instagram DMs, email threads) shown as one. A group, with no one person, stays a chat of
// its own. The threads stay as they are underneath: only the views are by person.

/// How a person is shown: their @slug, else their name, else what the thread is called.
fn person_label(slug: Option<&str>, name: Option<&str>, title: Option<&str>) -> String {
    slug.map(|s| format!("@{s}")).or_else(|| name.map(str::to_string)).or_else(|| title.map(str::to_string)).unwrap_or_else(|| "someone".into())
}

#[derive(sqlx::FromRow)]
struct ChatRow {
    contact_id: Option<Uuid>,
    conversation_id: Option<Uuid>,
    latest: Uuid,
    title: Option<String>,
    connectors: Vec<String>,
    last_item_at: Option<DateTime<Utc>>,
    attention: Option<String>,
    unread: bool,
    cards: i64,
    name: Option<String>,
    slug: Option<String>,
    avatar_key: Option<String>,
    body: Option<String>,
    author: Option<String>,
    connector: Option<String>,
}

/// The chat list by person, latest first: each person once (all their channels), each group once.
pub async fn list_chats(st: web::Data<AppState>, u: InboxReader, q: web::Query<ListQuery>) -> HttpResponse {
    let user = &u.0.user_id;
    let r: anyhow::Result<Json> = async {
        let rows: Vec<ChatRow> = sqlx::query_as(
            "WITH conv AS (
               SELECT c.id, c.connector, c.title, c.contact_id, c.last_item_at, c.attention,
                      c.last_in_at IS NOT NULL AND c.last_in_at > COALESCE(c.read_at, '-infinity'::timestamptz) AS unread,
                      (SELECT COUNT(*) FROM db_pigeon_actions a WHERE a.conversation_id = c.id AND a.status = 'pending')
                    + (SELECT COUNT(*) FROM db_pigeon_questions q WHERE q.conversation_id = c.id AND q.status = 'open')
                    + (SELECT COUNT(*) FROM db_pigeon_rule_runs r WHERE r.conversation_id = c.id AND r.status = 'pending')
                    + (SELECT COUNT(*) FROM db_pigeon_confirmations f WHERE f.conversation_id = c.id AND f.status = 'pending')
                    + (CASE WHEN c.needs_note IS NULL THEN 0 ELSE 1 END) AS cards
                 FROM db_pigeon_conversations c
                WHERE c.user_id = $1 AND c.last_item_at IS NOT NULL
             ), chats AS (
               SELECT COALESCE(contact_id::text, id::text) AS key,
                      (array_agg(contact_id))[1] AS contact_id,
                      CASE WHEN bool_and(contact_id IS NULL) THEN (array_agg(id))[1] END AS conversation_id,
                      (array_agg(id ORDER BY last_item_at DESC))[1] AS latest,
                      (array_agg(title ORDER BY last_item_at DESC))[1] AS title,
                      array_agg(DISTINCT connector) AS connectors,
                      max(last_item_at) AS last_item_at,
                      max(attention) AS attention,
                      bool_or(unread) AS unread,
                      sum(cards)::bigint AS cards
                 FROM conv GROUP BY 1
             )
             SELECT ch.contact_id, ch.conversation_id, ch.latest, ch.title, ch.connectors, ch.last_item_at, ch.attention, ch.unread, ch.cards,
                    ct.name, ct.slug, ct.avatar_key, li.body, li.author, li.connector
               FROM chats ch
               LEFT JOIN db_pigeon_contacts ct ON ct.id = ch.contact_id
               LEFT JOIN LATERAL (SELECT i.body, i.author, i.connector FROM db_pigeon_items i WHERE i.conversation_id = ch.latest ORDER BY i.at DESC LIMIT 1) li ON true
              WHERE ($2::text IS NULL OR $2 = ANY(ch.connectors))
                AND ($3::timestamptz IS NULL OR ch.last_item_at < $3)
                AND ($4::text IS NULL OR ct.name ILIKE '%' || $4 || '%' OR ch.title ILIKE '%' || $4 || '%'
                     OR ct.slug LIKE lower(ltrim($4, '@')) || '%')
                AND (NOT $6 OR ch.attention IS NOT NULL OR ch.cards > 0)
              ORDER BY ch.last_item_at DESC LIMIT $5",
        )
        .bind(user)
        .bind(q.connector.as_deref().filter(|c| !c.is_empty()))
        .bind(q.before)
        .bind(q.q.as_deref().map(str::trim).filter(|s| !s.is_empty()))
        .bind(q.limit.unwrap_or(50).clamp(1, 200))
        .bind(q.filter.as_deref() == Some("needs"))
        .fetch_all(&st.pool)
        .await?;
        let links = avatars::Links::new(&st.pool).await;
        let mut out: Vec<Json> = Vec::with_capacity(rows.len());
        for r in rows {
            let avatar = links.of(&st.pool, r.avatar_key.as_deref()).await.0;
            out.push(json!({
                    "avatar": avatar,
                    "key": match (r.contact_id, r.conversation_id) { (Some(c), _) => format!("p:{c}"), (_, Some(c)) => format!("c:{c}"), _ => format!("c:{}", r.latest) },
                    "contact_id": r.contact_id, "conversation_id": r.conversation_id, "latest": r.latest,
                    "with": person_label(r.slug.as_deref(), r.name.as_deref(), r.title.as_deref()),
                    "name": r.name.clone().or(r.title.clone()), "slug": r.slug,
                    "connectors": r.connectors, "connector": r.connector,
                    "last_item_at": r.last_item_at, "attention": r.attention,
                    "preview": r.body.map(|b| conversations::clip(&b, 120)), "last_author": r.author,
                    "unread": r.unread, "cards": r.cards,
            }));
        }
        Ok(json!({ "chats": out }))
    }
    .await;
    reply(r)
}

/// A person's threads, the latest first.
async fn person_threads(st: &AppState, user: &str, contact: Uuid) -> anyhow::Result<Vec<conversations::Conversation>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {} FROM db_pigeon_conversations WHERE user_id = $1 AND contact_id = $2 ORDER BY last_item_at DESC NULLS LAST",
        conversations::CONVERSATION_COLS
    ))
    .bind(user)
    .bind(contact)
    .fetch_all(&st.pool)
    .await?)
}

/// One person's chat: who they are, their threads (each channel's), the cards waiting on any of
/// them, and their switches. `conversation` is the latest thread.
pub async fn get_person_chat(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        let contact = people::mine(&st, user, id).await?;
        let threads = person_threads(&st, user, id).await?;
        let mut cards_out = Vec::new();
        for t in &threads {
            for c in cards::list(&st, user, Some(t.id)).await? {
                let mut v = serde_json::to_value(c)?;
                v["conversation_id"] = json!(t.id);
                cards_out.push(v);
            }
        }
        let reply_own: Option<String> =
            sqlx::query_scalar("SELECT policy FROM db_pigeon_policies WHERE user_id = $1 AND scope = 'contact' AND scope_id = $2 AND kind = 'reply'")
                .bind(user)
                .bind(id.to_string())
                .fetch_optional(&st.pool)
                .await?;
        let alerts_own: Option<String> = sqlx::query_scalar("SELECT level FROM db_pigeon_alert_levels WHERE user_id = $1 AND contact_id = $2")
            .bind(user)
            .bind(id)
            .fetch_optional(&st.pool)
            .await?;
        let unread = threads.iter().any(|t| t.last_in_at.is_some_and(|i| t.read_at.is_none_or(|r| i > r)));
        let (avatar, avatar_photo) = avatars::Links::new(&st.pool).await.of(&st.pool, contact.avatar_key.as_deref()).await;
        Ok(json!({
            "avatar": avatar, "avatar_photo": avatar_photo,
            "contact": contact,
            "with": person_label(contact.slug.as_deref(), contact.name.as_deref(), None),
            "name": contact.name,
            "conversation": threads.first(),
            "threads": threads,
            "unread": unread,
            "cards": cards_out,
            "switches": {
                "reply": policy::resolve(&st.pool, user, Kind::Reply, None, None).await?.as_str(),
                "reply_own": reply_own,
                "alerts": alerts::resolve(&st.pool, user, None, None).await?.as_str(),
                "alerts_own": alerts_own,
                "auto_enabled": policy::auto_enabled(&st.pool, user).await?,
            },
        }))
    }
    .await;
    reply(r)
}

#[derive(Deserialize)]
pub struct PersonItemsQuery {
    before: Option<DateTime<Utc>>,
    limit: Option<i64>,
    /// one channel's messages only
    connector: Option<String>,
}

/// A person's messages and news across their threads (or one channel's), oldest first, with
/// each message's thread and channel.
pub async fn person_items(st: web::Data<AppState>, u: InboxReader, path: web::Path<Uuid>, q: web::Query<PersonItemsQuery>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        people::mine(&st, user, id).await?;
        let connector = q.connector.as_deref().filter(|c| !c.is_empty());
        let threads: Vec<Uuid> = person_threads(&st, user, id).await?.into_iter().filter(|t| connector.is_none_or(|c| t.connector == c)).map(|t| t.id).collect();
        let limit = q.limit.unwrap_or(50).clamp(1, 200);
        let mut items: Vec<Json> = sqlx::query_scalar(&format!(
            "SELECT row_to_json(x)::jsonb FROM (SELECT {}, conversation_id, connector FROM db_pigeon_items
               WHERE conversation_id = ANY($1) AND ($2::timestamptz IS NULL OR at < $2) ORDER BY at DESC LIMIT $3) x",
            conversations::ITEM_COLS
        ))
        .bind(&threads)
        .bind(q.before)
        .bind(limit)
        .fetch_all(&st.pool)
        .await?;
        items.reverse();
        let more = items.len() as i64 == limit;
        let at = |v: &Json| v["at"].as_str().and_then(|s| DateTime::parse_from_rfc3339(s).ok()).map(|t| t.with_timezone(&Utc));
        let from = if more { items.first().and_then(at) } else { None };
        let news: Vec<(i64, String, Option<String>, DateTime<Utc>)> = sqlx::query_as(
            "SELECT id, text, url, created_at FROM db_pigeon_news WHERE user_id = $1 AND conversation_id = ANY($2)
               AND ($3::timestamptz IS NULL OR created_at >= $3) AND ($4::timestamptz IS NULL OR created_at < $4) ORDER BY created_at",
        )
        .bind(user)
        .bind(&threads)
        .bind(from)
        .bind(q.before)
        .fetch_all(&st.pool)
        .await?;
        let mut handles: Vec<String> =
            items.iter().filter(|i| i["direction"] == "in").filter_map(|i| i["sender"].as_str().map(str::to_string)).collect();
        handles.sort();
        handles.dedup();
        let people_rows: Vec<(String, Option<String>, Option<String>)> = sqlx::query_as(
            "SELECT h.handle, c.name, c.slug FROM db_pigeon_contact_handles h JOIN db_pigeon_contacts c ON c.id = h.contact_id
              WHERE h.user_id = $1 AND h.handle = ANY($2)",
        )
        .bind(user)
        .bind(&handles)
        .fetch_all(&st.pool)
        .await?;
        let senders: serde_json::Map<String, Json> =
            people_rows.into_iter().map(|(handle, name, slug)| (handle, json!({ "name": name, "slug": slug }))).collect();
        media::sign(&st.pool, &mut items).await;
        Ok(json!({
            "items": items,
            "senders": senders,
            "news": news.into_iter().map(|(id, text, url, at)| json!({ "id": id, "text": text, "url": url, "at": at })).collect::<Vec<_>>(),
            "more": more,
        }))
    }
    .await;
    reply(r)
}

/// The user opened a person's chat: what came in on any of their threads is read.
pub async fn person_read(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        people::mine(&st, user, id).await?;
        sqlx::query("UPDATE db_pigeon_conversations SET read_at = NOW() WHERE user_id = $1 AND contact_id = $2").bind(user).bind(id).execute(&st.pool).await?;
        events::publish(&st.pool, user, "conversations", None).await;
        Ok(json!({ "read": id }))
    }
    .await;
    reply(r)
}

/// Nothing more to do with this person: each of their threads that needed the user is handled.
pub async fn person_handled(st: web::Data<AppState>, u: InboxWriter, path: web::Path<Uuid>) -> HttpResponse {
    let user = &u.0.user_id;
    let id = path.into_inner();
    let r: anyhow::Result<Json> = async {
        for t in person_threads(&st, user, id).await? {
            if t.attention.is_some() || t.needs_note.is_some() {
                tools::mark_handled(&st, t.id).await?;
            }
        }
        Ok(json!({ "handled": id }))
    }
    .await;
    reply(r)
}

/// A message's file to save (as an attachment, by its name), streamed from storage.
pub async fn item_media(st: web::Data<AppState>, u: InboxReader, path: web::Path<(Uuid, String)>) -> HttpResponse {
    let (item, id) = path.into_inner();
    match media::download(&st.pool, &u.0.user_id, item, &id).await {
        Ok((mime, name, body)) => {
            let stream = futures_util::stream::unfold(body, |mut b| async move {
                b.next().await.map(|chunk| (chunk.map_err(|e| std::io::Error::other(e.to_string())), b))
            });
            let safe: String = name.chars().map(|c| if c == '"' || c.is_control() { '_' } else { c }).collect();
            HttpResponse::Ok()
                .content_type(mime)
                .insert_header((
                    "Content-Disposition",
                    format!("attachment; filename=\"{safe}\"; filename*=UTF-8''{}", urlencoding::encode(&name)),
                ))
                .streaming(stream)
        }
        Err(e) => HttpResponse::NotFound().json(json!({ "error": format!("{e:#}") })),
    }
}

/// The Inbox tools that only read: an `inbox.read` key may run them; the rest need `inbox.write`.
const READ_TOOLS: &[&str] = &[
    "pigeon_inbox", "pigeon_search", "pigeon_conversation", "pigeon_pending", "pigeon_rules", "pigeon_rule_runs",
    "pigeon_actions", "pigeon_contacts", "pigeon_policies", "pigeon_summary", "pigeon_connectors",
];

/// Piuma's Inbox tools, for a script or another assistant (the piuma-vault skill's pigeon.py):
/// each with what it does, its arguments' JSON schema, and whether it changes anything.
pub async fn list_tools(_u: InboxReader) -> HttpResponse {
    let tools: Vec<Json> = tools::defs()
        .into_iter()
        .map(|(name, description, parameters)| json!({ "name": name, "description": description, "parameters": parameters, "writes": !READ_TOOLS.contains(&name) }))
        .collect();
    HttpResponse::Ok().json(json!({ "tools": tools }))
}

/// One Inbox tool run as Piuma would (a big change becomes a card for the user's tap in the Inbox).
pub async fn run_tool(st: web::Data<AppState>, user: AuthenticatedUser, path: web::Path<String>, body: Option<web::Json<Json>>) -> HttpResponse {
    let name = path.into_inner();
    if !tools::names().contains(&name.as_str()) {
        return HttpResponse::NotFound().json(json!({ "error": format!("no Inbox tool {name}") }));
    }
    let need = if READ_TOOLS.contains(&name.as_str()) { "inbox.read" } else { "inbox.write" };
    if !check_permission(&user, need) {
        return HttpResponse::Forbidden().json(json!({ "error": format!("Access denied: {need} permission required") }));
    }
    let args = body.map(|b| b.into_inner()).filter(|a| a.is_object()).unwrap_or_else(|| json!({}));
    match tools::call(&st, &user.user_id, &name, &args).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => HttpResponse::BadRequest().json(json!({ "error": e })),
    }
}

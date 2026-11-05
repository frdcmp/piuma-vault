//! Reading conversations back: the row, its recent items, the person, and the transcript the
//! models read.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::Value as Json;
use sqlx::FromRow;
use uuid::Uuid;

use crate::db::db::DbPool;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Conversation {
    pub id: Uuid,
    pub user_id: String,
    pub connection_id: Option<i32>,
    pub connector: String,
    pub external_id: String,
    pub contact_id: Option<Uuid>,
    pub title: Option<String>,
    pub last_in_at: Option<DateTime<Utc>>,
    pub last_out_at: Option<DateTime<Utc>>,
    pub last_item_at: Option<DateTime<Utc>>,
    pub window_until: Option<DateTime<Utc>>,
    pub attention: Option<String>,
    pub needs_note: Option<String>,
    pub importance: Option<f32>,
    pub kind: Option<String>,
    pub triaged_at: Option<DateTime<Utc>>,
    pub handled_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
    pub summary: Option<String>,
    pub summary_at: Option<DateTime<Utc>>,
}

/// How many of the user's chats have something unread (a message in since they last read them):
/// the number on the phone's icon.
pub async fn unread_count(pool: &DbPool, user: &str) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_pigeon_conversations WHERE user_id = $1 AND last_in_at IS NOT NULL AND (read_at IS NULL OR last_in_at > read_at)",
    )
    .bind(user)
    .fetch_one(pool)
    .await?)
}

pub const CONVERSATION_COLS: &str = "id, user_id, connection_id, connector, external_id, contact_id, title, last_in_at, last_out_at, last_item_at, \
     window_until, attention, needs_note, importance, kind, triaged_at, handled_at, read_at, summary, summary_at";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Item {
    pub id: Uuid,
    pub direction: String,
    pub author: String,
    pub sender: Option<String>,
    pub sender_name: Option<String>,
    pub subject: Option<String>,
    pub body: String,
    /// photos, videos, voice notes, files: `[{type, …}]`
    pub media: Json,
    pub at: DateTime<Utc>,
    /// when Pigeon stored it (triage goes by this: a message can arrive long after it was sent)
    pub created_at: DateTime<Utc>,
    /// who it was sent to, and copied (email; empty elsewhere): addresses
    pub to_addrs: Json,
    pub cc_addrs: Json,
    /// emoji on it, one per person: `{who: {emoji, at, me, name}}` (who: their handle, or "me")
    pub reactions: Json,
    /// where it opens in its own app, on the web (an email in its mailbox)
    pub open_url: Option<String>,
    /// the user's sent from the Inbox: "inbox" (None: from the channel's own app)
    pub via: Option<String>,
}

pub const ITEM_COLS: &str = "id, direction, author, sender, sender_name, subject, body, media, at, created_at, \
     COALESCE(raw->'to', '[]'::jsonb) AS to_addrs, COALESCE(raw->'cc', '[]'::jsonb) AS cc_addrs, \
     COALESCE(raw->'reactions', '{}'::jsonb) AS reactions, raw->>'via' AS via, \
     (SELECT 'https://mail.google.com/mail/?authuser=' || k.account || '#all/' || db_pigeon_items.external_id \
        FROM db_pigeon_conversations v JOIN db_pigeon_connections k ON k.id = v.connection_id \
       WHERE v.id = db_pigeon_items.conversation_id AND db_pigeon_items.connector = 'gmail') AS open_url";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Contact {
    pub id: Uuid,
    pub user_id: String,
    pub name: Option<String>,
    pub slug: Option<String>,
    pub note: Option<String>,
    pub relationship: Option<String>,
    pub language: Option<String>,
    pub note_id: Option<Uuid>,
    /// their profile picture in storage (avatars.rs), if one was found
    pub avatar_key: Option<String>,
}

pub const CONTACT_COLS: &str = "id, user_id, name, slug, note, relationship, language, note_id, avatar_key";

impl Contact {
    /// Who they are to the user (`me`) and the language to write to them in, as lines for a prompt.
    pub fn facts(&self, me: &str) -> String {
        let mut s = String::new();
        if let Some(r) = self.relationship.as_deref().filter(|r| !r.trim().is_empty()) {
            s.push_str(&format!("Who they are to {me}: {r}\n"));
        }
        if let Some(l) = self.language.as_deref().filter(|l| !l.trim().is_empty()) {
            s.push_str(&format!("Write to them in: {l}\n"));
        }
        s
    }
}

pub async fn get(pool: &DbPool, id: Uuid) -> anyhow::Result<Option<Conversation>> {
    Ok(sqlx::query_as(&format!("SELECT {CONVERSATION_COLS} FROM db_pigeon_conversations WHERE id = $1")).bind(id).fetch_optional(pool).await?)
}

/// The last `limit` items, oldest first.
pub async fn recent_items(pool: &DbPool, id: Uuid, limit: i64) -> anyhow::Result<Vec<Item>> {
    let mut items: Vec<Item> = sqlx::query_as(
        &format!("SELECT {ITEM_COLS} FROM db_pigeon_items WHERE conversation_id = $1 ORDER BY at DESC LIMIT $2"),
    )
    .bind(id)
    .bind(limit)
    .fetch_all(pool)
    .await?;
    items.reverse();
    Ok(items)
}

pub async fn item(pool: &DbPool, id: Uuid) -> anyhow::Result<Option<Item>> {
    Ok(sqlx::query_as(&format!("SELECT {ITEM_COLS} FROM db_pigeon_items WHERE id = $1")).bind(id).fetch_optional(pool).await?)
}

pub async fn contact(pool: &DbPool, id: Option<Uuid>) -> anyhow::Result<Option<Contact>> {
    let Some(id) = id else { return Ok(None) };
    Ok(sqlx::query_as(&format!("SELECT {CONTACT_COLS} FROM db_pigeon_contacts WHERE id = $1"))
        .bind(id)
        .fetch_optional(pool)
        .await?)
}

/// Who the conversation is with, for a prompt or a list.
pub fn who(contact: Option<&Contact>, conv: &Conversation) -> String {
    contact
        .and_then(|c| c.name.clone())
        .or_else(|| conv.title.clone())
        .unwrap_or_else(|| "someone".into())
}

/// A body as a model should read it: whitespace squeezed, cut at `max` characters.
pub fn clip(s: &str, max: usize) -> String {
    let squeezed = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if squeezed.chars().count() <= max {
        squeezed
    } else {
        format!("{}…", squeezed.chars().take(max).collect::<String>())
    }
}

/// The user's own addresses and handles on every channel (their connected accounts), lowercase.
pub async fn my_handles(pool: &DbPool, user: &str) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar("SELECT DISTINCT lower(account) FROM db_pigeon_connections WHERE user_id = $1").bind(user).fetch_all(pool).await?)
}

/// Who an email went to, when it's more than just the user: " (to: …; cc: …)", their own
/// addresses shown by their name (`me.0`).
fn recipients(it: &Item, me: (&str, &[String])) -> String {
    let (name, me) = me;
    let list = |v: &Json| -> Vec<String> {
        v.as_array()
            .into_iter()
            .flatten()
            .filter_map(Json::as_str)
            .map(|a| if me.iter().any(|m| m.eq_ignore_ascii_case(a)) { name.to_string() } else { a.to_string() })
            .collect()
    };
    let (to, cc) = (list(&it.to_addrs), list(&it.cc_addrs));
    let just_them = cc.is_empty() && to.len() <= 1 && (it.direction == "out" || to.iter().all(|t| t == name));
    if just_them {
        return String::new();
    }
    let mut parts = vec![format!("to: {}", if to.is_empty() { "?".into() } else { to.join(", ") })];
    if !cc.is_empty() {
        parts.push(format!("cc: {}", cc.join(", ")));
    }
    format!(" ({})", parts.join("; "))
}

/// The items as lines: `[2026-11-01 14:05 UTC] Marco: …`. A subject is shown when it changes.
/// `me` is the user's name and their own handles.
pub fn transcript(items: &[Item], them: &str, me: (&str, &[String]), max_body: usize) -> String {
    let mut out = String::new();
    let mut subject: Option<&str> = None;
    for it in items {
        let who = match it.author.as_str() {
            "me" => me.0.to_string(),
            "pigeon" => format!("{} (sent by Pigeon)", me.0),
            // name and address: a name alone can be the user's own (another of their accounts)
            _ => match (&it.sender_name, &it.sender) {
                (Some(n), Some(a)) => format!("{n} <{a}>"),
                (n, a) => n.clone().or_else(|| a.clone()).unwrap_or_else(|| them.to_string()),
            },
        };
        if let Some(s) = it.subject.as_deref().filter(|s| !s.is_empty()) {
            if subject != Some(s) {
                out.push_str(&format!("— subject: {s}\n"));
                subject = Some(s);
            }
        }
        out.push_str(&format!("[{}] {who}{}: {}{}\n", it.at.format("%Y-%m-%d %H:%M UTC"), recipients(it, me), clip(&said(it), max_body), reacted(it, me.0)));
    }
    out
}

/// A message's words as a model reads them: a voice note's words in place of "[voice message]".
pub fn said(it: &Item) -> String {
    let mut body = it.body.clone();
    for m in it.media.as_array().into_iter().flatten() {
        let Some(words) = m["transcript"].as_str().map(str::trim).filter(|w| !w.is_empty()) else { continue };
        let label = m["label"].as_str().unwrap_or("voice message");
        let heard = format!("[{label}: \"{words}\"]");
        let tag = format!("[{label}]");
        body = if body.contains(&tag) { body.replacen(&tag, &heard, 1) } else { format!("{body}\n{heard}").trim().to_string() };
    }
    body
}

/// A message's reactions, as the transcript shows them: " (reactions: ❤️ Anna, 👍 Marco)".
fn reacted(it: &Item, me: &str) -> String {
    let Some(r) = it.reactions.as_object().filter(|r| !r.is_empty()) else { return String::new() };
    let each: Vec<String> = r
        .iter()
        .filter_map(|(who, v)| {
            let emoji = v["emoji"].as_str().filter(|e| !e.is_empty())?;
            let by = if v["me"].as_bool() == Some(true) { me.to_string() } else { v["name"].as_str().unwrap_or(who).to_string() };
            Some(format!("{emoji} {by}"))
        })
        .collect();
    if each.is_empty() {
        String::new()
    } else {
        format!(" (reactions: {})", each.join(", "))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn item(author: &str, subject: Option<&str>, body: &str) -> Item {
        Item {
            id: Uuid::nil(),
            direction: if author == "them" { "in".into() } else { "out".into() },
            author: author.into(),
            sender: Some("marco@example.com".into()),
            sender_name: Some("Marco".into()),
            subject: subject.map(String::from),
            body: body.into(),
            media: serde_json::json!([]),
            at: DateTime::parse_from_rfc3339("2026-11-01T14:05:00Z").unwrap().with_timezone(&Utc),
            created_at: Utc::now(),
            to_addrs: serde_json::json!(["me@example.com"]),
            cc_addrs: serde_json::json!([]),
            reactions: serde_json::json!({}),
            open_url: None,
            via: None,
        }
    }

    #[test]
    fn a_transcript_names_each_side_and_shows_subject_changes() {
        let t = transcript(
            &[item("them", Some("Invoice"), "Can you send\n\n it?"), item("me", Some("Invoice"), "Sure"), item("pigeon", Some("Re: x"), "Done")],
            "Marco",
            ("Alex", &["me@example.com".to_string()]),
            100,
        );
        assert_eq!(
            t,
            "— subject: Invoice\n[2026-11-01 14:05 UTC] Marco <marco@example.com>: Can you send it?\n[2026-11-01 14:05 UTC] Alex: Sure\n— subject: Re: x\n[2026-11-01 14:05 UTC] Alex (sent by Pigeon): Done\n"
        );
        assert_eq!(clip("a b c d", 3), "a b…");
    }

    #[test]
    fn copied_people_are_shown() {
        let mut it = item("them", None, "Can you two sort it out?");
        it.to_addrs = serde_json::json!(["luca@example.com", "me@example.com"]);
        it.cc_addrs = serde_json::json!(["boss@example.com"]);
        let t = transcript(&[it], "Marco", ("Alex", &["me@example.com".to_string()]), 100);
        assert_eq!(
            t,
            "[2026-11-01 14:05 UTC] Marco <marco@example.com> (to: luca@example.com, Alex; cc: boss@example.com): Can you two sort it out?\n"
        );
    }
}

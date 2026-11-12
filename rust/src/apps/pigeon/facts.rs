//! What Pigeon knows about the user right now (`db_pigeon_facts`): where they are (the phone
//! writes it), anything they say about themselves, and what they left for one person to hear
//! (a pass-on: "if he asks tonight, we're at the ramen place"). A fact is a row, never a column:
//! a tool reads the one with its key, at the level the person holds (`levels`: the same fact
//! said with less and less, `{"country": "Japan", "city": "Tokyo", …}`).
//!
//!   - about the user (no `for_contact`, no `for_chat`): one per key, the latest; whoever holds
//!     the tool's permission may be told it
//!   - a pass-on (`for_contact` or `for_chat` set, key `passon`): for them alone, gone once said
//!     or at its end
//!
//! A fact past its end isn't used, and the worker sweeps it; one older than its tool allows
//! (`Tool::fresh`: a place half an hour old) is stale: Pigeon only drafts with it.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value as Json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::pigeon::access::Holder;
use crate::apps::pigeon::state::State;
use crate::apps::pigeon::{events, offer, people, tools};
use crate::db::db::DbPool;

/// A pass-on's key, and the tool it's told through.
pub const PASSON: &str = "passon";
/// A pass-on's words, at most.
pub const MAX_TEXT: usize = 500;
const MAX_KEY: usize = 40;
/// A fact's value and levels, as JSON text, at most.
const MAX_JSON: usize = 4000;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct Fact {
    pub id: Uuid,
    #[serde(skip_serializing)]
    pub user_id: String,
    pub key: String,
    pub for_contact: Option<Uuid>,
    pub for_chat: Option<Uuid>,
    pub value: Json,
    pub levels: Json,
    pub source: String,
    pub at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

const COLS: &str = "id, user_id, key, for_contact, for_chat, value, levels, source, at, expires_at";
const LIVE: &str = "(expires_at IS NULL OR expires_at > NOW())";

fn words(v: &Json) -> Option<String> {
    match v {
        Json::Null => None,
        Json::String(s) => Some(s.trim().to_string()).filter(|s| !s.is_empty()),
        v => Some(v.to_string()),
    }
}

impl Fact {
    /// It, said at one level; none when it has nothing for that level.
    pub fn at_level(&self, level: &str) -> Option<String> {
        words(&self.levels[level])
    }

    /// It in words: a pass-on's line, else the most it says.
    pub fn text(&self) -> String {
        if let Some(t) = words(&self.value["text"]) {
            return t;
        }
        let fullest = offer::find(&self.key).and_then(|t| t.levels.iter().rev().find_map(|l| self.at_level(l.name)));
        fullest.or_else(|| self.levels.as_object().and_then(|o| o.values().rev().find_map(words))).unwrap_or_else(|| self.value.to_string())
    }

    /// Older than its tool allows: Pigeon doesn't tell it on its own.
    pub fn stale(&self) -> bool {
        offer::find(&self.key).and_then(|t| t.fresh).is_some_and(|m| Utc::now() - self.at > chrono::Duration::minutes(m))
    }
}

/// The user's fact with this key, while it lasts.
pub async fn latest(pool: &DbPool, user: &str, key: &str) -> anyhow::Result<Option<Fact>> {
    Ok(sqlx::query_as(&format!("SELECT {COLS} FROM db_pigeon_facts WHERE user_id = $1 AND key = $2 AND for_contact IS NULL AND for_chat IS NULL AND {LIVE}"))
        .bind(user)
        .bind(key)
        .fetch_optional(pool)
        .await?)
}

/// Every fact that lasts: about the user, and left for someone.
pub async fn list(pool: &DbPool, user: &str) -> anyhow::Result<Vec<Fact>> {
    Ok(sqlx::query_as(&format!("SELECT {COLS} FROM db_pigeon_facts WHERE user_id = $1 AND {LIVE} ORDER BY at DESC")).bind(user).fetch_all(pool).await?)
}

/// What the user left for the one who writes in a chat: for its person, or for the chat itself.
pub async fn passons(pool: &DbPool, user: &str, contact: Option<Uuid>, chat: Option<Uuid>) -> anyhow::Result<Vec<Fact>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLS} FROM db_pigeon_facts WHERE user_id = $1 AND key = $2 AND {LIVE}
            AND ((for_contact IS NOT NULL AND for_contact = $3) OR (for_chat IS NOT NULL AND for_chat = $4)) ORDER BY at"
    ))
    .bind(user)
    .bind(PASSON)
    .bind(contact)
    .bind(chat)
    .fetch_all(pool)
    .await?)
}

/// Everything left for one person: for them, or for one of their chats.
pub async fn left_for(pool: &DbPool, user: &str, contact: Uuid) -> anyhow::Result<Vec<Fact>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {COLS} FROM db_pigeon_facts WHERE user_id = $1 AND key = $2 AND {LIVE}
            AND (for_contact = $3 OR for_chat IN (SELECT id FROM db_pigeon_conversations WHERE user_id = $1 AND contact_id = $3)) ORDER BY at"
    ))
    .bind(user)
    .bind(PASSON)
    .bind(contact)
    .fetch_all(pool)
    .await?)
}

fn small(v: &Json, what: &str) -> anyhow::Result<()> {
    if v.to_string().len() > MAX_JSON {
        anyhow::bail!("{what} is too long");
    }
    Ok(())
}

/// Write the user's fact for a key: the latest replaces the one before.
pub async fn set(st: &State, user: &str, key: &str, value: &Json, levels: &Json, source: &str, expires_at: Option<DateTime<Utc>>) -> anyhow::Result<Fact> {
    let key = key.trim().to_lowercase();
    if key.is_empty() || key.len() > MAX_KEY || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        anyhow::bail!("a fact's key is a short name: location, status");
    }
    if key == PASSON {
        anyhow::bail!("a pass-on is left for someone: pigeon_passon");
    }
    if !levels.is_object() && !levels.is_null() {
        anyhow::bail!("levels is an object: {{\"city\": \"Tokyo\"}}");
    }
    if let (Some(tool), Some(l)) = (offer::find(&key), levels.as_object()) {
        if let Some(k) = l.keys().find(|k| tool.level(k).is_none()) {
            anyhow::bail!("{}'s levels: {}, not {k}", tool.name, tool.levels.iter().map(|l| l.name).collect::<Vec<_>>().join(", "));
        }
    }
    small(value, "the value")?;
    small(levels, "the levels")?;
    if expires_at.is_some_and(|u| u <= Utc::now()) {
        anyhow::bail!("the end is already past");
    }
    let f: Fact = sqlx::query_as(&format!(
        "INSERT INTO db_pigeon_facts (user_id, key, value, levels, source, at, expires_at) VALUES ($1, $2, $3, $4, $5, NOW(), $6)
         ON CONFLICT (user_id, key) WHERE for_contact IS NULL AND for_chat IS NULL
         DO UPDATE SET value = EXCLUDED.value, levels = EXCLUDED.levels, source = EXCLUDED.source, at = NOW(), expires_at = EXCLUDED.expires_at
         RETURNING {COLS}"
    ))
    .bind(user)
    .bind(&key)
    .bind(if value.is_null() { json!({}) } else { value.clone() })
    .bind(if levels.is_null() { json!({}) } else { levels.clone() })
    .bind(source.trim().chars().take(40).collect::<String>())
    .bind(expires_at)
    .fetch_one(&st.pool)
    .await?;
    events::publish(&st.pool, user, "access", None).await;
    Ok(f)
}

/// Leave something for one person, or one chat, to hear when they ask.
pub async fn leave(st: &State, user: &str, h: Holder, text: &str, until: Option<DateTime<Utc>>) -> anyhow::Result<Fact> {
    let text = text.trim();
    if text.is_empty() {
        anyhow::bail!("what should they hear?");
    }
    if text.chars().count() > MAX_TEXT {
        anyhow::bail!("at most {MAX_TEXT} characters");
    }
    if until.is_some_and(|u| u <= Utc::now()) {
        anyhow::bail!("the end is already past");
    }
    let (contact, chat) = match h {
        Holder::Contact(c) => {
            people::mine(st, user, c).await?;
            (Some(c), None)
        }
        Holder::Conversation(c) => {
            tools::own_conversation(st, user, c).await?;
            (None, Some(c))
        }
        Holder::Group(_) => anyhow::bail!("a pass-on is for one person or one chat"),
    };
    let f: Fact = sqlx::query_as(&format!(
        "INSERT INTO db_pigeon_facts (user_id, key, for_contact, for_chat, value, source, expires_at) VALUES ($1, $2, $3, $4, $5, 'user', $6) RETURNING {COLS}"
    ))
    .bind(user)
    .bind(PASSON)
    .bind(contact)
    .bind(chat)
    .bind(json!({ "text": text }))
    .bind(until)
    .fetch_one(&st.pool)
    .await?;
    events::publish(&st.pool, user, "access", None).await;
    Ok(f)
}

pub async fn delete(st: &State, user: &str, id: Uuid) -> anyhow::Result<Fact> {
    let f: Option<Fact> = sqlx::query_as(&format!("DELETE FROM db_pigeon_facts WHERE id = $1 AND user_id = $2 RETURNING {COLS}")).bind(id).bind(user).fetch_optional(&st.pool).await?;
    let f = f.ok_or_else(|| anyhow::anyhow!("no such fact"))?;
    events::publish(&st.pool, user, "access", None).await;
    Ok(f)
}

/// Pass-ons that were told: gone.
pub async fn said(st: &State, user: &str, ids: &[Uuid]) -> anyhow::Result<()> {
    if ids.is_empty() {
        return Ok(());
    }
    let n = sqlx::query("DELETE FROM db_pigeon_facts WHERE id = ANY($1) AND user_id = $2 AND key = $3").bind(ids).bind(user).bind(PASSON).execute(&st.pool).await?.rows_affected();
    if n > 0 {
        events::publish(&st.pool, user, "access", None).await;
    }
    Ok(())
}

/// The facts past their end, gone (the worker, every minute).
pub async fn sweep(st: &State) -> anyhow::Result<usize> {
    let mut users: Vec<String> = sqlx::query_scalar("DELETE FROM db_pigeon_facts WHERE expires_at IS NOT NULL AND expires_at <= NOW() RETURNING user_id").fetch_all(&st.pool).await?;
    let n = users.len();
    users.sort();
    users.dedup();
    for u in &users {
        events::publish(&st.pool, u, "access", None).await;
    }
    Ok(n)
}

/// Facts for the screens and the assistants: each with its words, its tool, and who it's for.
pub async fn views(pool: &DbPool, facts: &[Fact]) -> anyhow::Result<Vec<Json>> {
    let contacts: Vec<Uuid> = facts.iter().filter_map(|f| f.for_contact).collect();
    let chats: Vec<Uuid> = facts.iter().filter_map(|f| f.for_chat).collect();
    let people: Vec<(Uuid, Option<String>, Option<String>)> = match contacts.is_empty() {
        true => Vec::new(),
        false => sqlx::query_as("SELECT id, name, slug FROM db_pigeon_contacts WHERE id = ANY($1)").bind(&contacts).fetch_all(pool).await?,
    };
    let rooms: Vec<(Uuid, Option<String>, Option<String>)> = match chats.is_empty() {
        true => Vec::new(),
        false => sqlx::query_as("SELECT c.id, c.title, ct.name FROM db_pigeon_conversations c LEFT JOIN db_pigeon_contacts ct ON ct.id = c.contact_id WHERE c.id = ANY($1)")
            .bind(&chats)
            .fetch_all(pool)
            .await?,
    };
    Ok(facts
        .iter()
        .map(|f| {
            let whom = match (f.for_contact, f.for_chat) {
                (Some(c), _) => {
                    let name = people.iter().find(|p| p.0 == c).and_then(|p| p.1.clone().or_else(|| p.2.as_ref().map(|s| format!("@{s}"))));
                    json!({ "kind": "contact", "id": c, "name": name.unwrap_or_else(|| "someone".into()) })
                }
                (_, Some(c)) => {
                    let name = rooms.iter().find(|r| r.0 == c).and_then(|r| r.2.clone().or_else(|| r.1.clone()));
                    json!({ "kind": "conversation", "id": c, "name": name.unwrap_or_else(|| "a chat".into()) })
                }
                _ => Json::Null,
            };
            let tool = offer::find(&f.key);
            json!({
                "id": f.id,
                "key": f.key,
                "tool": tool.map(|t| t.name),
                "label": tool.map(|t| t.label.to_string()).unwrap_or_else(|| f.key.clone()),
                "text": f.text(),
                "value": f.value,
                "levels": f.levels,
                "source": f.source,
                "at": f.at,
                "expires_at": f.expires_at,
                "stale": f.stale(),
                "for": whom,
            })
        })
        .collect())
}

/// Everything Pigeon knows right now: `facts` about the user, `passons` left for someone.
pub async fn all(st: &State, user: &str) -> anyhow::Result<Json> {
    let (passons, facts): (Vec<Fact>, Vec<Fact>) = list(&st.pool, user).await?.into_iter().partition(|f| f.key == PASSON);
    Ok(json!({ "facts": views(&st.pool, &facts).await?, "passons": views(&st.pool, &passons).await? }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fact(key: &str, value: Json, levels: Json, minutes_old: i64) -> Fact {
        Fact {
            id: Uuid::new_v4(),
            user_id: "u".into(),
            key: key.into(),
            for_contact: None,
            for_chat: None,
            value,
            levels,
            source: "phone".into(),
            at: Utc::now() - chrono::Duration::minutes(minutes_old),
            expires_at: None,
        }
    }

    #[test]
    fn a_fact_says_itself_at_a_level() {
        let f = fact("location", json!({ "lat": 35.66, "lon": 139.7 }), json!({ "country": "Japan", "city": "Tokyo", "area": "Shibuya, Tokyo" }), 5);
        assert_eq!(f.at_level("city").as_deref(), Some("Tokyo"));
        assert_eq!(f.at_level("exact"), None, "what the phone couldn't name isn't said");
        assert_eq!(f.text(), "Shibuya, Tokyo", "in words: the most it says");
        assert!(!f.stale());
        assert!(fact("location", json!({}), json!({ "city": "Tokyo" }), 45).stale(), "a place of 45 minutes ago is old");
        assert!(!fact("status", json!({}), json!({}), 600).stale(), "what has no tool doesn't age");
        assert_eq!(fact(PASSON, json!({ "text": "we're at the ramen place" }), json!({}), 0).text(), "we're at the ramen place");
    }
}

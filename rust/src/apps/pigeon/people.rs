//! What Pigeon knows about a person, so a reply sounds like the user to them:
//!
//!   memory  who they are to the user and what's going on between them: written by the LLM from
//!           their conversations on every channel, rewritten as more comes in
//!   styles  per channel, how the user writes to them there (an email to someone is not a
//!           WhatsApp to them): from their own messages on that channel; a group, no one
//!           person's, has its own (`group_style`), from the user's messages in it
//!
//! Both are written when a reply needs them and are due, or now by `learn`. Learning first
//! gathers: each connector brings past conversations in as history (stored, never triaged or
//! answered), so there is something to learn from.

use std::collections::HashSet;
use std::sync::Mutex;

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value as Json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::pigeon::ai::llm;
use crate::apps::pigeon::connectors;
use crate::apps::pigeon::conversations::{self, Contact};
use crate::apps::pigeon::owner;
use crate::apps::pigeon::slugs;
use crate::apps::pigeon::state::{AppState, State};

/// A channel's style is written once the user has this many messages to the person there.
pub const STYLE_MIN_MESSAGES: i64 = 3;
/// Rewritten when they wrote this many more there, or, with any new one, after REFRESH_DAYS.
const STYLE_EVERY: i64 = 5;
/// The memory: written once there are this many items with the person, rewritten after this
/// many more (or, with any new one, after REFRESH_DAYS).
const MEMORY_MIN_ITEMS: i64 = 2;
const MEMORY_EVERY: i64 = 6;
const REFRESH_DAYS: i64 = 14;
/// What the memory is written from: their latest conversations, the latest items of each.
const MEMORY_CONVERSATIONS: i64 = 12;
const MEMORY_ITEMS_EACH: i64 = 12;
/// Gathering: threads per person, and for everyone at once.
const GATHER_ONE: usize = 40;
const GATHER_ALL: usize = 400;

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Memory {
    pub memory: String,
    /// items with the person when it was written
    pub items: i32,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Style {
    pub connector: String,
    pub profile: String,
    /// the user's messages to the person on the channel when it was written
    pub messages: i32,
    pub updated_at: DateTime<Utc>,
}

pub async fn memory(st: &State, contact: Uuid) -> anyhow::Result<Option<Memory>> {
    Ok(sqlx::query_as("SELECT memory, items, updated_at FROM db_pigeon_contact_memories WHERE contact_id = $1")
        .bind(contact)
        .fetch_optional(&st.pool)
        .await?)
}

pub async fn styles(st: &State, contact: Uuid) -> anyhow::Result<Vec<Style>> {
    Ok(sqlx::query_as("SELECT connector, profile, messages, updated_at FROM db_pigeon_contact_styles WHERE contact_id = $1 ORDER BY connector")
        .bind(contact)
        .fetch_all(&st.pool)
        .await?)
}

pub async fn style(st: &State, contact: Uuid, connector: &str) -> anyhow::Result<Option<Style>> {
    Ok(sqlx::query_as("SELECT connector, profile, messages, updated_at FROM db_pigeon_contact_styles WHERE contact_id = $1 AND connector = $2")
        .bind(contact)
        .bind(connector)
        .fetch_optional(&st.pool)
        .await?)
}

/// A message that is only an attachment's stand-in ("[image]") or a link says nothing of how
/// the user writes.
const WORDS_ONLY: &str = r"length(trim(i.body)) > 0 AND i.body !~ '^\s*\[[a-z_ ]+\]\s*$' AND i.body !~ '^\s*https?://\S+\s*$'";

/// How the user writes in a group (a chat that is no one person's), when written.
pub async fn group_style(st: &State, conversation: Uuid) -> anyhow::Result<Option<Style>> {
    Ok(sqlx::query_as(
        "SELECT c.connector, s.profile, s.messages, s.updated_at FROM db_pigeon_conversation_styles s
           JOIN db_pigeon_conversations c ON c.id = s.conversation_id WHERE s.conversation_id = $1",
    )
    .bind(conversation)
    .fetch_optional(&st.pool)
    .await?)
}

/// The user's own latest messages in a conversation, newest first (words, not attachments).
pub async fn chat_voice(st: &State, conversation: Uuid, n: i64) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar(&format!(
        "SELECT i.body FROM db_pigeon_items i WHERE i.conversation_id = $1 AND i.author = 'me' AND {WORDS_ONLY}
          ORDER BY i.at DESC LIMIT $2"
    ))
    .bind(conversation)
    .bind(n)
    .fetch_all(&st.pool)
    .await?)
}

/// How long the user's messages usually are, in characters: the median of their latest ones to
/// this person on the channel (`contact`), else in this conversation. None under
/// STYLE_MIN_MESSAGES.
pub async fn usual_length(st: &State, contact: Option<Uuid>, conversation: Uuid, connector: &str) -> anyhow::Result<Option<i64>> {
    let (n, median): (i64, Option<f64>) = sqlx::query_as(&format!(
        "SELECT COUNT(*), percentile_cont(0.5) WITHIN GROUP (ORDER BY len) FROM (
           SELECT length(trim(i.body)) AS len FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
            WHERE i.author = 'me' AND {WORDS_ONLY}
              AND (($1::uuid IS NOT NULL AND c.contact_id = $1 AND i.connector = $3) OR ($1::uuid IS NULL AND c.id = $2))
            ORDER BY i.at DESC LIMIT 40) mine"
    ))
    .bind(contact)
    .bind(conversation)
    .bind(connector)
    .fetch_one(&st.pool)
    .await?;
    Ok(median.filter(|_| n >= STYLE_MIN_MESSAGES).map(|m| m.round() as i64))
}

/// Write how the user writes in a group, when due (or `force`). True when written.
pub async fn ensure_group_style(st: &State, conv: &conversations::Conversation, force: bool) -> anyhow::Result<bool> {
    let n: i64 = sqlx::query_scalar(&format!(
        "SELECT COUNT(*) FROM db_pigeon_items i WHERE i.conversation_id = $1 AND i.author = 'me' AND {WORDS_ONLY}"
    ))
    .bind(conv.id)
    .fetch_one(&st.pool)
    .await?;
    if n < STYLE_MIN_MESSAGES {
        return Ok(false);
    }
    if !force {
        if let Some(s) = group_style(st, conv.id).await? {
            if !due(n, s.messages, s.updated_at, STYLE_EVERY) {
                return Ok(false);
            }
        }
    }
    if !llm::available(&st.pool).await {
        return Ok(false);
    }
    let me = owner::get(&st.pool, &conv.user_id).await.name;
    let mine = chat_voice(st, conv.id, 40).await?;
    let examples: String = mine.iter().map(|m| format!("- {}\n", conversations::clip(m, 500))).collect();
    let group = conv.title.as_deref().filter(|t| !t.is_empty()).unwrap_or("a group");
    let profile = llm::text(
        &st.pool,
        "You describe how a person writes in one group chat (WhatsApp, …), so someone else can write there exactly like \
         them. Answer with 3 to 6 short bullet points in English: language(s) and dialect, length, formality, emoji and \
         punctuation habits, how they address the others, nicknames, slang or recurring phrases, what they leave out. \
         Describe; don't quote whole messages.",
        &format!("Messages {me} wrote in the group \"{group}\" on {} (newest first):\n{examples}", conv.connector),
    )
    .await?;
    sqlx::query(
        "INSERT INTO db_pigeon_conversation_styles (conversation_id, profile, messages) VALUES ($1, $2, $3)
         ON CONFLICT (conversation_id) DO UPDATE SET profile = EXCLUDED.profile, messages = EXCLUDED.messages, updated_at = NOW()",
    )
    .bind(conv.id)
    .bind(&profile)
    .bind(n as i32)
    .execute(&st.pool)
    .await?;
    Ok(true)
}

/// The user's own latest messages to this person (on `connector` when given), newest first,
/// with the channel each was on.
pub async fn voice_examples(st: &State, contact: Uuid, connector: Option<&str>, n: i64) -> anyhow::Result<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        "SELECT i.connector, i.body FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.contact_id = $1 AND i.author = 'me' AND length(trim(i.body)) > 0 AND ($2::text IS NULL OR i.connector = $2)
          ORDER BY i.at DESC LIMIT $3",
    )
    .bind(contact)
    .bind(connector)
    .bind(n)
    .fetch_all(&st.pool)
    .await?)
}

async fn count_mine(st: &State, contact: Uuid, connector: &str) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.contact_id = $1 AND i.connector = $2 AND i.author = 'me' AND length(trim(i.body)) > 0",
    )
    .bind(contact)
    .bind(connector)
    .fetch_one(&st.pool)
    .await?)
}

async fn count_items(st: &State, contact: Uuid) -> anyhow::Result<i64> {
    Ok(sqlx::query_scalar("SELECT COUNT(*) FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id WHERE c.contact_id = $1")
        .bind(contact)
        .fetch_one(&st.pool)
        .await?)
}

/// Whether something written from `then_count` at `then` is due again at `now_count`.
fn due(now_count: i64, then_count: i32, then: DateTime<Utc>, every: i64) -> bool {
    let grown = now_count - then_count as i64;
    grown >= every || (grown > 0 && Utc::now() - then > chrono::Duration::days(REFRESH_DAYS))
}

/// Write how the user writes to this person on `connector`, when due (or `force`). True when
/// written.
pub async fn ensure_style(st: &State, c: &Contact, connector: &str, force: bool) -> anyhow::Result<bool> {
    let n = count_mine(st, c.id, connector).await?;
    if n < STYLE_MIN_MESSAGES {
        return Ok(false);
    }
    if !force {
        if let Some(s) = style(st, c.id, connector).await? {
            if !due(n, s.messages, s.updated_at, STYLE_EVERY) {
                return Ok(false);
            }
        }
    }
    if !llm::available(&st.pool).await {
        return Ok(false);
    }
    let me = owner::get(&st.pool, &c.user_id).await.name;
    let mine = voice_examples(st, c.id, Some(connector), 40).await?;
    let examples: String = mine.iter().map(|(_, m)| format!("- {}\n", conversations::clip(m, 500))).collect();
    let profile = llm::text(
            &st.pool,
            "You describe how a person writes to one specific contact on one channel (email, WhatsApp, …), so someone else \
             can write there exactly like them. Answer with 3 to 6 short bullet points in English: language(s), length, \
             formality, greetings and sign-offs, emoji and punctuation habits, nicknames or recurring phrases. Describe; \
             don't quote whole messages.",
            &format!("Messages {me} wrote to {} on {connector} (newest first):\n{examples}", c.name.as_deref().unwrap_or("this person")),
        )
        .await?;
    sqlx::query(
        "INSERT INTO db_pigeon_contact_styles (contact_id, connector, profile, messages) VALUES ($1, $2, $3, $4)
         ON CONFLICT (contact_id, connector) DO UPDATE SET profile = EXCLUDED.profile, messages = EXCLUDED.messages, updated_at = NOW()",
    )
    .bind(c.id)
    .bind(connector)
    .bind(&profile)
    .bind(n as i32)
    .execute(&st.pool)
    .await?;
    Ok(true)
}

/// Write what Pigeon knows about this person, when due (or `force`). True when written.
pub async fn ensure_memory(st: &State, c: &Contact, force: bool) -> anyhow::Result<bool> {
    let n = count_items(st, c.id).await?;
    if n < MEMORY_MIN_ITEMS {
        return Ok(false);
    }
    let before = memory(st, c.id).await?;
    if !force {
        if let Some(m) = &before {
            if !due(n, m.items, m.updated_at, MEMORY_EVERY) {
                return Ok(false);
            }
        }
    }
    if !llm::available(&st.pool).await {
        return Ok(false);
    }
    let name = owner::get(&st.pool, &c.user_id).await.name;
    let handles = conversations::my_handles(&st.pool, &c.user_id).await?;
    let me = (name.as_str(), handles.as_slice());
    let them = c.name.clone().unwrap_or_else(|| "this person".into());
    let convs: Vec<conversations::Conversation> = sqlx::query_as(&format!(
        "SELECT {} FROM db_pigeon_conversations WHERE contact_id = $1 AND last_item_at IS NOT NULL ORDER BY last_item_at DESC LIMIT $2",
        conversations::CONVERSATION_COLS
    ))
    .bind(c.id)
    .bind(MEMORY_CONVERSATIONS)
    .fetch_all(&st.pool)
    .await?;
    let mut text = String::new();
    for conv in &convs {
        let items = conversations::recent_items(&st.pool, conv.id, MEMORY_ITEMS_EACH).await?;
        text.push_str(&format!(
            "\n=== {} conversation{}\n{}",
            conv.connector,
            conv.title.as_deref().filter(|t| !t.is_empty()).map(|t| format!(" \"{t}\"")).unwrap_or_default(),
            conversations::transcript(&items, &them, me, 500)
        ));
    }
    let mut prompt = format!("The person: {them}\n{}", c.facts(&name));
    if let Some(note) = c.note.as_deref().filter(|n| !n.trim().is_empty()) {
        prompt.push_str(&format!("{name}'s own note on them (true, keep it in mind): {note}\n"));
    }
    if let Some(m) = &before {
        prompt.push_str(&format!("\nWhat you remembered before (update it; drop what the conversations show is over):\n{}\n", m.memory));
    }
    prompt.push_str(&format!("\nTheir conversations with {name}, latest first, each oldest message first:\n{text}"));
    let written = llm::text(
            &st.pool,
            &format!("You keep Pigeon's memory of one person {name} talks to, so {name}'s replies to them make sense. Write 4 to 12 short \
             bullet points in English: who they are to {name} (friend, family, client, colleague, a company), what they \
             talk about, facts worth remembering (names, places, dates, preferences, the language they use), and what is \
             open between them (questions waiting, promises, plans). Only what the messages show: never guess. No quotes, \
             no preamble."),
            &prompt,
        )
        .await?;
    sqlx::query(
        "INSERT INTO db_pigeon_contact_memories (contact_id, memory, items) VALUES ($1, $2, $3)
         ON CONFLICT (contact_id) DO UPDATE SET memory = EXCLUDED.memory, items = EXCLUDED.items, updated_at = NOW()",
    )
    .bind(c.id)
    .bind(&written)
    .bind(n as i32)
    .execute(&st.pool)
    .await?;
    Ok(true)
}

/// The channels the person has conversations on.
async fn channels(st: &State, contact: Uuid) -> anyhow::Result<Vec<String>> {
    Ok(sqlx::query_scalar("SELECT DISTINCT connector FROM db_pigeon_conversations WHERE contact_id = $1").bind(contact).fetch_all(&st.pool).await?)
}

/// One of the user's contacts, or an error naming it.
pub async fn mine(st: &State, user: &str, id: Uuid) -> anyhow::Result<Contact> {
    conversations::contact(&st.pool, Some(id)).await?.filter(|c| c.user_id == user).ok_or_else(|| anyhow::anyhow!("no such contact: {id}"))
}

/// One person, now: their past conversations brought in from every channel they're on (the
/// last `days`), then their memory and each channel's style written again.
pub async fn learn(st: &State, user: &str, contact: Uuid, days: i64) -> anyhow::Result<Json> {
    let c = mine(st, user, contact).await?;
    let handles: Vec<(String, String)> =
        sqlx::query_as("SELECT connector, handle FROM db_pigeon_contact_handles WHERE contact_id = $1").bind(contact).fetch_all(&st.pool).await?;
    let mut gathered = serde_json::Map::new();
    for (connector, handle) in &handles {
        let Some(conn) = connectors::find(st, connector) else { continue };
        if conn.available(st).is_err() {
            continue;
        }
        // one handle that can't be gathered (an Instagram @user before they wrote, a channel's
        // limit) doesn't stop the others, nor the learning
        let n = match conn.gather(st, user, Some(handle), days, GATHER_ONE).await {
            Ok(n) => json!(n),
            Err(e) => json!(format!("not brought in: {e:#}")),
        };
        gathered.insert(format!("{connector}:{handle}"), n);
    }
    ensure_memory(st, &c, true).await?;
    for ch in channels(st, contact).await? {
        ensure_style(st, &c, &ch, true).await?;
    }
    Ok(json!({
        "contact_id": contact,
        "name": c.name,
        "brought_in": gathered,
        "memory": memory(st, contact).await?.map(|m| m.memory),
        "styles": styles(st, contact).await?,
    }))
}

/// Two contacts that are one person (their email and their Instagram): `other` folds into `keep`,
/// whose handles, conversations and rules it takes. What both have: `keep`'s name, slug and
/// per-kind policies win, the notes are joined, a channel's style stays `keep`'s; the memory is
/// written again from everything (best effort: the merge stands without it).
pub async fn merge(st: &State, user: &str, keep: Uuid, other: Uuid) -> anyhow::Result<Json> {
    if keep == other {
        anyhow::bail!("that's the same contact");
    }
    let a = mine(st, user, keep).await?;
    let b = mine(st, user, other).await?;
    let note = match (a.note.as_deref().map(str::trim).filter(|n| !n.is_empty()), b.note.as_deref().map(str::trim).filter(|n| !n.is_empty())) {
        (Some(x), Some(y)) if x != y => Some(format!("{x}\n{y}")),
        (x, y) => x.or(y).map(str::to_string),
    };
    let (keep_s, other_s) = (keep.to_string(), other.to_string());
    let mut tx = st.pool.begin().await?;
    let moved = |sql: &'static str| sqlx::query(sql).bind(keep).bind(other);
    let handles = moved("UPDATE db_pigeon_contact_handles SET contact_id = $1 WHERE contact_id = $2").execute(&mut *tx).await?.rows_affected();
    let convs = moved("UPDATE db_pigeon_conversations SET contact_id = $1 WHERE contact_id = $2").execute(&mut *tx).await?.rows_affected();
    let rules = moved("UPDATE db_pigeon_rules SET contact_id = $1 WHERE contact_id = $2").execute(&mut *tx).await?.rows_affected();
    moved(
        "UPDATE db_pigeon_contact_styles SET contact_id = $1 WHERE contact_id = $2
            AND connector NOT IN (SELECT connector FROM db_pigeon_contact_styles WHERE contact_id = $1)",
    )
    .execute(&mut *tx)
    .await?;
    moved("UPDATE db_pigeon_contact_memories SET contact_id = $1 WHERE contact_id = $2 AND NOT EXISTS (SELECT 1 FROM db_pigeon_contact_memories WHERE contact_id = $1)")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "UPDATE db_pigeon_policies SET scope_id = $2, updated_at = NOW() WHERE user_id = $1 AND scope = 'contact' AND scope_id = $3
            AND kind NOT IN (SELECT kind FROM db_pigeon_policies WHERE user_id = $1 AND scope = 'contact' AND scope_id = $2)",
    )
    .bind(user)
    .bind(&keep_s)
    .bind(&other_s)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM db_pigeon_policies WHERE user_id = $1 AND scope = 'contact' AND scope_id = $2").bind(user).bind(&other_s).execute(&mut *tx).await?;
    // the other's alert level, when the kept one has none
    sqlx::query(
        "UPDATE db_pigeon_alert_levels SET contact_id = $2 WHERE user_id = $1 AND contact_id = $3
            AND NOT EXISTS (SELECT 1 FROM db_pigeon_alert_levels WHERE user_id = $1 AND contact_id = $2)",
    )
    .bind(user)
    .bind(keep)
    .bind(other)
    .execute(&mut *tx)
    .await?;
    sqlx::query("DELETE FROM db_pigeon_contacts WHERE id = $1").bind(other).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE db_pigeon_contacts SET name = COALESCE(name, $2), note = $3, relationship = COALESCE(relationship, $4),
                language = COALESCE(language, $5), note_id = COALESCE(note_id, $6), slug = COALESCE(slug, $7), updated_at = NOW()
          WHERE id = $1",
    )
    .bind(keep)
    .bind(&b.name)
    .bind(&note)
    .bind(&b.relationship)
    .bind(&b.language)
    .bind(b.note_id)
    .bind(&b.slug)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;

    let c = mine(st, user, keep).await?;
    if let Err(e) = ensure_memory(st, &c, true).await {
        log::warn!("merge: the memory of {keep}: {e:#}");
    }
    Ok(json!({
        "contact_id": keep,
        "merged": other,
        "name": c.name,
        "note": c.note,
        "moved": { "handles": handles, "conversations": convs, "rules": rules },
        "memory": memory(st, keep).await?.map(|m| m.memory),
    }))
}

/// A contact's fields to set: a field given is set ("" clears it), one left out stays.
#[derive(Debug, Default, serde::Deserialize)]
pub struct ContactInput {
    pub contact_id: Option<Uuid>,
    pub name: Option<String>,
    pub relationship: Option<String>,
    pub language: Option<String>,
    /// the vault note about them (its id; "" unlinks it)
    pub note_id: Option<String>,
    /// their @slug, the user's choice (else made from the name)
    pub slug: Option<String>,
    #[serde(default)]
    pub add_handles: Vec<HandleInput>,
    #[serde(default)]
    pub remove_handles: Vec<HandleInput>,
}

#[derive(Debug, serde::Deserialize)]
pub struct HandleInput {
    pub channel: String,
    pub handle: String,
}

/// A handle as Pigeon keeps it: an email address lowercased; on Instagram the account's id, or
/// its username as "@user" until they first write (the id then joins it).
fn handle_of(h: &HandleInput) -> anyhow::Result<(String, String)> {
    let ch = h.channel.trim().to_lowercase();
    let v = h.handle.trim().to_lowercase();
    match ch.as_str() {
        "gmail" if v.contains('@') && !v.starts_with('@') => Ok((ch, v)),
        "gmail" => anyhow::bail!("gmail: an email address, not {:?}", h.handle),
        "instagram" => {
            let v = v.trim_start_matches("https://www.instagram.com/").trim_end_matches('/').to_string();
            if v.chars().all(|c| c.is_ascii_digit()) && !v.is_empty() {
                Ok((ch, v))
            } else {
                let u = v.trim_start_matches('@');
                if u.is_empty() || !u.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_') {
                    anyhow::bail!("instagram: a username (@user) or the account's id, not {:?}", h.handle);
                }
                Ok((ch, format!("@{u}")))
            }
        }
        "whatsapp" => phone_handle(&v).map(|p| (ch, p)).ok_or_else(|| anyhow::anyhow!("whatsapp: a phone number with its country code (+39 333 …), not {:?}", h.handle)),
        _ => anyhow::bail!("channel: gmail, instagram or whatsapp, not {:?}", h.channel),
    }
}

/// A phone number as WhatsApp's handle: "+" and the digits, country code first ("+39 333-123 4567",
/// "0039 333 1234567" → "+393331234567"). None without a country code.
pub fn phone_handle(v: &str) -> Option<String> {
    // "+66 (0)81 …": the (0) is dialled at home only
    let v = v.trim().replace("(0)", "");
    let v = v.as_str();
    let digits: String = v.chars().filter(char::is_ascii_digit).collect();
    let international = if v.starts_with('+') { Some(digits.as_str()) } else { digits.strip_prefix("00") };
    international.filter(|d| (8..=15).contains(&d.len()) && !v.chars().any(|c| c.is_alphabetic())).map(|d| format!("+{d}"))
}

/// A name that is only a number or an address: what someone known by their handle alone is called.
fn bare(name: Option<&str>) -> bool {
    match name.map(str::trim) {
        None | Some("") => true,
        Some(n) => n.contains('@') || n.chars().all(|c| c.is_ascii_digit() || "+ -()".contains(c)),
    }
}

/// A Postgres pattern for the same: a name that is only digits, spaces, +, - and brackets.
const BARE_NAME: &str = r"^[0-9+ ()-]*$";

/// Someone still known only by number or address whose message carries a name (WhatsApp's, the
/// email's From) takes it, and a slug from it. `conversation`: theirs.
pub async fn name_from_message(st: &State, conversation: Uuid, name: &str) -> anyhow::Result<()> {
    let name = name.trim();
    if bare(Some(name)) {
        return Ok(());
    }
    let renamed: Option<Uuid> = sqlx::query_scalar(
        "UPDATE db_pigeon_contacts c SET name = $2, updated_at = NOW() FROM db_pigeon_conversations v
          WHERE v.id = $1 AND c.id = v.contact_id AND (c.name IS NULL OR c.name ~ $3 OR c.name LIKE '%@%')
          RETURNING c.id",
    )
    .bind(conversation)
    .bind(name)
    .bind(BARE_NAME)
    .fetch_optional(&st.pool)
    .await?;
    if let Some(id) = renamed {
        log::info!("pigeon: contact {id} named {name} from their message");
        slugs::of(st, id).await?;
    }
    Ok(())
}

/// Names from the user's WhatsApp address book: someone known only by number takes the name the
/// user saved them under, and each saved contact who isn't among the people yet becomes one. The
/// nameless left take the name WhatsApp shows for them, else the one their messages carry. New
/// names get their slugs. `only`: just this person (nobody added).
pub async fn import_whatsapp(st: &State, user: &str, only: Option<Uuid>) -> anyhow::Result<Json> {
    let mut book = connectors::whatsapp::address_book(st, user).await?;
    if let Some(id) = only {
        let theirs: Vec<String> = sqlx::query_scalar("SELECT handle FROM db_pigeon_contact_handles WHERE user_id = $1 AND contact_id = $2 AND connector = 'whatsapp'")
            .bind(user)
            .bind(id)
            .fetch_all(&st.pool)
            .await?;
        if theirs.is_empty() {
            anyhow::bail!("this person has no WhatsApp number in the Inbox");
        }
        book.retain(|e| e["phone"].as_str().is_some_and(|p| theirs.iter().any(|h| h == p)));
    }
    let text = |v: &Json| v.as_str().map(str::trim).filter(|s| !s.is_empty()).map(str::to_string);
    let (mut named, mut added) = (0, 0);
    for e in &book {
        let Some(phone) = e["phone"].as_str() else { continue };
        let saved = text(&e["name"]);
        let shown = saved.clone().or_else(|| text(&e["business"]));
        let display = shown.clone().or_else(|| text(&e["push"]));
        let owner: Option<(Uuid, Option<String>)> = sqlx::query_as(
            "SELECT c.id, c.name FROM db_pigeon_contact_handles h JOIN db_pigeon_contacts c ON c.id = h.contact_id
              WHERE h.user_id = $1 AND h.connector = 'whatsapp' AND h.handle = $2",
        )
        .bind(user)
        .bind(phone)
        .fetch_optional(&st.pool)
        .await?;
        match owner {
            Some((id, name)) => {
                if let Some(n) = shown.as_deref().filter(|_| bare(name.as_deref())) {
                    sqlx::query("UPDATE db_pigeon_contacts SET name = $2, updated_at = NOW() WHERE id = $1").bind(id).bind(n).execute(&st.pool).await?;
                    named += 1;
                }
                if display.is_some() {
                    sqlx::query("UPDATE db_pigeon_contact_handles SET display_name = $3 WHERE user_id = $1 AND connector = 'whatsapp' AND handle = $2")
                        .bind(user)
                        .bind(phone)
                        .bind(&display)
                        .execute(&st.pool)
                        .await?;
                }
            }
            // only the people the user saved on the phone, not everyone in their groups
            None => {
                if let Some(n) = saved.as_ref().filter(|_| only.is_none()) {
                    let mut tx = st.pool.begin().await?;
                    let id: Uuid = sqlx::query_scalar("INSERT INTO db_pigeon_contacts (user_id, name) VALUES ($1, $2) RETURNING id")
                        .bind(user)
                        .bind(n)
                        .fetch_one(&mut *tx)
                        .await?;
                    sqlx::query("INSERT INTO db_pigeon_contact_handles (user_id, connector, handle, contact_id, display_name) VALUES ($1, 'whatsapp', $2, $3, $4)")
                        .bind(user)
                        .bind(phone)
                        .bind(id)
                        .bind(&display)
                        .execute(&mut *tx)
                        .await?;
                    tx.commit().await?;
                    added += 1;
                }
            }
        }
    }
    let from_channel = sqlx::query(
        "UPDATE db_pigeon_contacts c SET name = h.display_name, updated_at = NOW() FROM db_pigeon_contact_handles h
          WHERE h.contact_id = c.id AND c.user_id = $1 AND (c.name IS NULL OR c.name ~ $2 OR c.name LIKE '%@%')
            AND h.display_name IS NOT NULL AND h.display_name !~ $2 AND ($3::uuid IS NULL OR c.id = $3)",
    )
    .bind(user)
    .bind(BARE_NAME)
    .bind(only)
    .execute(&st.pool)
    .await?
    .rows_affected();
    let from_messages = sqlx::query(
        "UPDATE db_pigeon_contacts c SET name = s.sender_name, updated_at = NOW()
           FROM (SELECT DISTINCT ON (h.contact_id) h.contact_id, i.sender_name
                   FROM db_pigeon_contact_handles h
                   JOIN db_pigeon_items i ON i.connector = h.connector AND i.sender = h.handle AND i.direction = 'in'
                  WHERE h.user_id = $1 AND i.sender_name IS NOT NULL AND i.sender_name !~ $2
                  ORDER BY h.contact_id, i.at DESC) s
          WHERE s.contact_id = c.id AND (c.name IS NULL OR c.name ~ $2 OR c.name LIKE '%@%') AND ($3::uuid IS NULL OR c.id = $3)",
    )
    .bind(user)
    .bind(BARE_NAME)
    .bind(only)
    .execute(&st.pool)
    .await?
    .rows_affected();
    let slugged = slugs::backfill(st).await?;
    let person = match only {
        Some(id) => sqlx::query_as::<_, (Option<String>, Option<String>)>("SELECT name, slug FROM db_pigeon_contacts WHERE id = $1")
            .bind(id)
            .fetch_optional(&st.pool)
            .await?
            .map(|(name, slug)| json!({ "id": id, "name": name, "slug": slug })),
        None => None,
    };
    Ok(json!({
        "person": person,
        "address_book": book.len(), "named": named, "added": added,
        "named_from_whatsapp": from_channel, "named_from_messages": from_messages, "slugs_given": slugged,
    }))
}

fn field(v: &Option<String>) -> Option<Option<String>> {
    v.as_ref().map(|s| Some(s.trim().to_string()).filter(|s| !s.is_empty()))
}

/// Create a contact (no contact_id: a name needed) or change one: its fields and handles. A
/// handle that is someone else's is refused (the same person twice: merge them).
pub async fn set_contact(st: &State, user: &str, input: ContactInput) -> anyhow::Result<Json> {
    let add = input.add_handles.iter().map(handle_of).collect::<anyhow::Result<Vec<_>>>()?;
    let remove = input.remove_handles.iter().map(handle_of).collect::<anyhow::Result<Vec<_>>>()?;
    let note_id = match field(&input.note_id) {
        Some(Some(id)) => {
            let id = Uuid::parse_str(&id).map_err(|_| anyhow::anyhow!("note_id is not a UUID"))?;
            let theirs = sqlx::query("SELECT 1 FROM notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL").bind(id).bind(user).execute(&st.pool).await?;
            if theirs.rows_affected() == 0 {
                anyhow::bail!("no such note: {id}");
            }
            Some(Some(id))
        }
        Some(None) => Some(None),
        None => None,
    };
    let mut tx = st.pool.begin().await?;
    let id = match input.contact_id {
        Some(id) => {
            let n = sqlx::query("SELECT 1 FROM db_pigeon_contacts WHERE id = $1 AND user_id = $2").bind(id).bind(user).execute(&mut *tx).await?.rows_affected();
            if n == 0 {
                anyhow::bail!("no such contact: {id}");
            }
            id
        }
        None => {
            let name = field(&input.name).flatten().ok_or_else(|| anyhow::anyhow!("a new contact needs a name"))?;
            sqlx::query_scalar("INSERT INTO db_pigeon_contacts (user_id, name) VALUES ($1, $2) RETURNING id").bind(user).bind(name).fetch_one(&mut *tx).await?
        }
    };
    // each given field set (NULL when cleared), each left out kept
    for (col, v) in [("name", field(&input.name)), ("relationship", field(&input.relationship)), ("language", field(&input.language))] {
        let Some(v) = v else { continue };
        let v = if col == "relationship" { v.map(|r| r.to_lowercase()) } else { v };
        sqlx::query(&format!("UPDATE db_pigeon_contacts SET {col} = $2, updated_at = NOW() WHERE id = $1")).bind(id).bind(v).execute(&mut *tx).await?;
    }
    if let Some(n) = note_id {
        sqlx::query("UPDATE db_pigeon_contacts SET note_id = $2, updated_at = NOW() WHERE id = $1").bind(id).bind(n).execute(&mut *tx).await?;
    }
    for (ch, h) in &add {
        let owner: Option<Uuid> = sqlx::query_scalar("SELECT contact_id FROM db_pigeon_contact_handles WHERE user_id = $1 AND connector = $2 AND handle = $3")
            .bind(user)
            .bind(ch)
            .bind(h)
            .fetch_optional(&mut *tx)
            .await?;
        match owner {
            Some(o) if o == id => {}
            Some(o) => anyhow::bail!("{ch} {h} is contact {o}'s: if they are the same person, merge them"),
            None => {
                sqlx::query("INSERT INTO db_pigeon_contact_handles (user_id, connector, handle, contact_id) VALUES ($1, $2, $3, $4)")
                    .bind(user)
                    .bind(ch)
                    .bind(h)
                    .bind(id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    for (ch, h) in &remove {
        sqlx::query("DELETE FROM db_pigeon_contact_handles WHERE user_id = $1 AND connector = $2 AND handle = $3 AND contact_id = $4")
            .bind(user)
            .bind(ch)
            .bind(h)
            .bind(id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    if let Some(slug) = input.slug.as_deref().filter(|s| !s.trim().is_empty()) {
        crate::apps::pigeon::slugs::set(st, user, id, slug).await?;
    }
    view(st, user, id).await
}

/// A contact as Piuma and the Inbox see it.
pub async fn view(st: &State, user: &str, id: Uuid) -> anyhow::Result<Json> {
    let c = mine(st, user, id).await?;
    let handles: Vec<(String, String, Option<String>)> =
        sqlx::query_as("SELECT connector, handle, display_name FROM db_pigeon_contact_handles WHERE contact_id = $1 ORDER BY connector, handle")
            .bind(id)
            .fetch_all(&st.pool)
            .await?;
    let slug = crate::apps::pigeon::slugs::of(st, id).await?;
    // their own switches (None: they follow the default)
    let replies_own: Option<String> =
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
    let mut out = json!({
        "contact_id": c.id, "slug": slug.map(|s| format!("@{s}")), "name": c.name, "relationship": c.relationship, "language": c.language,
        "note_id": c.note_id, "note": c.note,
        "alerts": crate::apps::pigeon::alerts::resolve(&st.pool, user, Some(id), None).await?.as_str(),
        "replies": crate::apps::pigeon::policy::resolve(&st.pool, user, connectors::Kind::Reply, Some(id), None).await?.as_str(),
        "replies_own": replies_own, "alerts_own": alerts_own,
        "handles": handles.into_iter().map(|(ch, h, d)| json!({ "channel": ch, "handle": h, "shown_as": d })).collect::<Vec<_>>(),
        "memory": memory(st, id).await?.map(|m| m.memory),
        "styles": styles(st, id).await?.into_iter().map(|s| (s.connector, json!(s.profile))).collect::<serde_json::Map<_, _>>(),
    });
    crate::apps::pigeon::avatars::Links::new(&st.pool).await.add(&st.pool, c.avatar_key.as_deref(), &mut out).await;
    Ok(out)
}

/// The users a learning run is going for.
static LEARNING: Mutex<Option<HashSet<String>>> = Mutex::new(None);

/// Everyone the user wrote to in the last `days`, in the background: the conversations they
/// wrote in brought in, then each person's memory and styles written where due. False when a run
/// is going for them already.
pub fn learn_all(st: AppState, user: String, days: i64) -> bool {
    if !LEARNING.lock().unwrap().get_or_insert_with(HashSet::new).insert(user.clone()) {
        return false;
    }
    tokio::task::spawn_local(async move {
        if let Err(e) = learn_all_now(&st, &user, days).await {
            log::warn!("learn: {e:#}");
        }
        LEARNING.lock().unwrap().get_or_insert_with(HashSet::new).remove(&user);
    });
    true
}

async fn learn_all_now(st: &State, user: &str, days: i64) -> anyhow::Result<()> {
    for conn in &st.connectors {
        if conn.available(st).is_err() {
            continue;
        }
        match conn.gather(st, user, None, days, GATHER_ALL).await {
            Ok(n) => log::info!("learn: {} brought in {n} message(s) from the last {days} days", conn.id()),
            Err(e) => log::warn!("learn: gathering {}: {e:#}", conn.id()),
        }
    }
    // the people the user writes to themselves
    let ids: Vec<Uuid> = sqlx::query_scalar(
        "SELECT DISTINCT c.contact_id FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.user_id = $1 AND i.author = 'me' AND c.contact_id IS NOT NULL",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let (mut memories, mut styles_written) = (0, 0);
    for id in &ids {
        let Some(c) = conversations::contact(&st.pool, Some(*id)).await? else { continue };
        match ensure_memory(st, &c, false).await {
            Ok(true) => memories += 1,
            Ok(false) => {}
            Err(e) => log::warn!("learn: memory of {id}: {e:#}"),
        }
        for ch in channels(st, *id).await? {
            match ensure_style(st, &c, &ch, false).await {
                Ok(true) => styles_written += 1,
                Ok(false) => {}
                Err(e) => log::warn!("learn: {ch} style of {id}: {e:#}"),
            }
        }
    }
    log::info!("learn: {} people, {memories} memories and {styles_written} styles written", ids.len());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::phone_handle;

    #[test]
    fn a_phone_number_as_a_handle() {
        assert_eq!(phone_handle("+39 333-123 4567").as_deref(), Some("+393331234567"));
        assert_eq!(phone_handle("0039 333 1234567").as_deref(), Some("+393331234567"));
        assert_eq!(phone_handle("+66 (0)81 234 5678").as_deref(), Some("+66812345678"));
        assert_eq!(phone_handle("333 1234567"), None, "no country code");
        assert_eq!(phone_handle("+39 abc"), None);
        assert_eq!(phone_handle("+1 2"), None, "too short");
    }
}

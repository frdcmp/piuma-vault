//! Away: the user is somewhere else for a while (asleep, on a plane, in a meeting) and Pigeon
//! answers people on WhatsApp and Instagram itself, as Pigeon, never as them: every message it
//! writes then starts with its mark (`mark`), so they know who's talking. It tells them the user is
//! away (the reason only to people the user writes to, `known`), takes messages, and turns what
//! they ask into tasks and questions for the user (the intaker, as always); it never agrees to
//! anything for them. Their chats still need the user: an away reply doesn't mark them handled.
//! Where the user writes themselves, Pigeon steps back there (`actions::quiet_until`).
//!
//! Set from the Inbox, Piuma or a script (`pigeon_away`, the skill's pigeon.py), kept in `db_pigeon_settings` (key
//! `away`); it ends when the user ends it or at its `until` (`expire_due`, the worker's sweep).
//! On the way back, Pigeon's chat gets what happened (`recap`).

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::Value as Json;
use uuid::Uuid;

use crate::apps::pigeon::state::State;
use crate::apps::pigeon::{cards, conversations, events, owner};
use crate::db::db::DbPool;

const KEY: &str = "away";
/// The channels Pigeon answers on while the user is away.
pub const CHANNELS: &[&str] = &["whatsapp", "instagram"];
/// The longest a reason is.
pub const MAX_REASON: usize = 200;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Away {
    /// why, in the user's words ("sleeping", "on a plane to Rome")
    pub reason: String,
    pub since: DateTime<Utc>,
    /// back then; none: until they end it
    pub until: Option<DateTime<Utc>>,
}

/// The user's away, while it lasts.
pub async fn get(pool: &DbPool, user: &str) -> anyhow::Result<Option<Away>> {
    let v: Option<Json> = sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(KEY).fetch_optional(pool).await?;
    let away = v.and_then(|v| serde_json::from_value::<Away>(v).ok());
    Ok(away.filter(|a| a.until.is_none_or(|u| u > Utc::now())))
}

/// Away from now (a new away, or the same one with a new reason or end).
pub async fn set(st: &State, user: &str, reason: &str, until: Option<DateTime<Utc>>) -> anyhow::Result<Away> {
    let reason = reason.trim();
    if reason.is_empty() {
        anyhow::bail!("say why you're away (sleeping, on a plane, in a meeting…)");
    }
    if reason.chars().count() > MAX_REASON {
        anyhow::bail!("the reason is {MAX_REASON} characters at most");
    }
    if until.is_some_and(|u| u <= Utc::now()) {
        anyhow::bail!("the end is already past");
    }
    // still away: the same away goes on (since stays: what Pigeon said counts once)
    let since = get(&st.pool, user).await?.map(|a| a.since).unwrap_or_else(Utc::now);
    let away = Away { reason: reason.to_string(), since, until };
    sqlx::query(
        "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    )
    .bind(user)
    .bind(KEY)
    .bind(serde_json::to_value(&away)?)
    .execute(&st.pool)
    .await?;
    events::publish(&st.pool, user, "settings", None).await;
    log::info!("pigeon: {user} away ({}), until {:?}", away.reason, away.until);
    Ok(away)
}

/// Back: the away ends, and Pigeon's chat says what happened meanwhile. None: wasn't away.
pub async fn end(st: &State, user: &str) -> anyhow::Result<Option<Away>> {
    let v: Option<Json> = sqlx::query_scalar("DELETE FROM db_pigeon_settings WHERE user_id = $1 AND key = $2 RETURNING value").bind(user).bind(KEY).fetch_optional(&st.pool).await?;
    let Some(away) = v.and_then(|v| serde_json::from_value::<Away>(v).ok()) else { return Ok(None) };
    events::publish(&st.pool, user, "settings", None).await;
    let text = recap(st, user, &away).await?;
    cards::news(st, user, None, &text, None, true).await;
    log::info!("pigeon: {user} back ({})", away.reason);
    Ok(Some(away))
}

/// The aways past their end, ended (the worker, every minute).
pub async fn expire_due(st: &State) -> anyhow::Result<usize> {
    let users: Vec<String> = sqlx::query_scalar(
        "SELECT user_id FROM db_pigeon_settings WHERE key = $1 AND value->>'until' IS NOT NULL AND (value->>'until')::timestamptz <= NOW()",
    )
    .bind(KEY)
    .fetch_all(&st.pool)
    .await?;
    for u in &users {
        end(st, u).await?;
    }
    Ok(users.len())
}

/// What Pigeon's away messages start with: who's talking (the first in a chat says whose
/// assistant it is). WhatsApp shows *bold*; Instagram doesn't.
pub fn mark(connector: &str, name: &str, first: bool) -> String {
    let pigeon = if connector == "whatsapp" { "*Pigeon*" } else { "Pigeon" };
    if first {
        format!("🕊️ {pigeon}, {name}'s assistant: ")
    } else {
        format!("🕊️ {pigeon}: ")
    }
}

/// Whether Pigeon already answered in this chat during this away.
pub async fn answered_here(pool: &DbPool, conversation: Uuid, away: &Away) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_actions WHERE conversation_id = $1 AND kind = 'reply' AND status = 'done'
             AND (args->>'away')::boolean AND decided_at >= $2)",
    )
    .bind(conversation)
    .bind(away.since)
    .fetch_one(pool)
    .await?)
}

/// Someone the user writes to (themselves, on any channel): they may hear why the user is away;
/// a stranger hears only that they are.
pub async fn known(pool: &DbPool, contact: Option<Uuid>) -> anyhow::Result<bool> {
    let Some(c) = contact else { return Ok(true) };
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_items i JOIN db_pigeon_conversations v ON v.id = i.conversation_id
                         WHERE v.contact_id = $1 AND i.author = 'me')",
    )
    .bind(c)
    .fetch_one(pool)
    .await?)
}

/// While the user was away: each chat Pigeon answered in, how many times, and their latest
/// message; and what waits for the user.
async fn recap(st: &State, user: &str, away: &Away) -> anyhow::Result<String> {
    let me = owner::get(&st.pool, user).await;
    let chats: Vec<(Uuid, i64)> = sqlx::query_as(
        "SELECT conversation_id, COUNT(*) FROM db_pigeon_actions
          WHERE user_id = $1 AND kind = 'reply' AND status = 'done' AND (args->>'away')::boolean AND decided_at >= $2
          GROUP BY conversation_id ORDER BY MAX(decided_at) DESC",
    )
    .bind(user)
    .bind(away.since)
    .fetch_all(&st.pool)
    .await?;
    let waiting: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM db_pigeon_actions WHERE user_id = $1 AND status = 'pending' AND created_at >= $2")
        .bind(user)
        .bind(away.since)
        .fetch_one(&st.pool)
        .await?;
    let asked: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_pigeon_questions q JOIN db_pigeon_conversations c ON c.id = q.conversation_id
          WHERE c.user_id = $1 AND q.status = 'open' AND q.created_at >= $2",
    )
    .bind(user)
    .bind(away.since)
    .fetch_one(&st.pool)
    .await?;
    let mut s = format!("Welcome back! Away since {} ({}).", me.local(away.since).format("%a %H:%M"), away.reason);
    if chats.is_empty() {
        s.push_str(" Nobody needed an answer meanwhile.");
    } else {
        s.push_str(&format!(" Pigeon answered for you in {} chat{}:", chats.len(), if chats.len() == 1 { "" } else { "s" }));
        for (conv, n) in &chats {
            let Some(c) = conversations::get(&st.pool, *conv).await? else { continue };
            let contact = conversations::contact(&st.pool, c.contact_id).await?;
            let who = conversations::who(contact.as_ref(), &c);
            let last: Option<String> = sqlx::query_scalar("SELECT body FROM db_pigeon_items WHERE conversation_id = $1 AND direction = 'in' ORDER BY at DESC LIMIT 1")
                .bind(conv)
                .fetch_optional(&st.pool)
                .await?;
            let times = if *n == 1 { String::new() } else { format!(" ({n} messages)") };
            match last.filter(|l| !l.trim().is_empty()) {
                Some(l) => s.push_str(&format!("\n• {who}{times}: \"{}\"", conversations::clip(l.trim(), 120))),
                None => s.push_str(&format!("\n• {who}{times}")),
            }
        }
    }
    if waiting + asked > 0 {
        s.push_str(&format!("\nWaiting for you: {waiting} proposal(s), {asked} question(s), here in Pigeon's chat."));
    }
    Ok(s)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_mark_says_who_is_talking() {
        assert_eq!(mark("whatsapp", "Francesco", true), "🕊️ *Pigeon*, Francesco's assistant: ");
        assert_eq!(mark("whatsapp", "Francesco", false), "🕊️ *Pigeon*: ");
        assert_eq!(mark("instagram", "Francesco", false), "🕊️ Pigeon: ");
    }
}

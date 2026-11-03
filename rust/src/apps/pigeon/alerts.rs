//! Alerts: how loud each person is on the user's phone, now that the Inbox is where messages
//! reach them (their own apps' notifications off). One switch per contact (a conversation's own
//! for a WhatsApp group, which has no contact; the user's default for the rest):
//!
//!   - all: every message they write rings, and cards do
//!   - smart (the default): their messages arrive silently; a card, something waiting, rings
//!   - quiet: everything arrives silently
//!   - off: nothing reaches the phone; it's all in the Inbox for later
//!
//! Urgent beats the switch (Jev's `urgent`: someone in trouble, something that can't wait): its
//! card rings even when they're quiet or off. Kept in `db_pigeon_alert_levels`, the most specific
//! wins.

use uuid::Uuid;

use crate::db::db::DbPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Level {
    All,
    Smart,
    Quiet,
    Off,
}

pub const LEVELS: [Level; 4] = [Level::All, Level::Smart, Level::Quiet, Level::Off];

impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Level::All => "all",
            Level::Smart => "smart",
            Level::Quiet => "quiet",
            Level::Off => "off",
        }
    }

    pub fn parse(s: &str) -> Option<Level> {
        LEVELS.into_iter().find(|l| l.as_str() == s.trim().to_lowercase())
    }

    pub fn label(self) -> &'static str {
        match self {
            Level::All => "🔔 All",
            Level::Smart => "🔉 Smart",
            Level::Quiet => "🔕 Quiet",
            Level::Off => "⛔ Off",
        }
    }
}

/// How something reaches the user's phone.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Delivery {
    Ring,
    Silent,
    Skip,
}

/// Their message, as it comes in.
pub fn for_message(level: Level) -> Delivery {
    match level {
        Level::All => Delivery::Ring,
        Level::Smart | Level::Quiet => Delivery::Silent,
        Level::Off => Delivery::Skip,
    }
}

/// A card (something waits for the user), urgent or not.
pub fn for_brief(level: Level, urgent: bool) -> Delivery {
    match level {
        _ if urgent => Delivery::Ring,
        Level::All | Level::Smart => Delivery::Ring,
        Level::Quiet => Delivery::Silent,
        Level::Off => Delivery::Skip,
    }
}

/// The level for a conversation (its own, else its contact's, else the user's default).
pub async fn resolve(pool: &DbPool, user: &str, contact: Option<Uuid>, conversation: Option<Uuid>) -> anyhow::Result<Level> {
    let own: Option<String> = sqlx::query_scalar(
        "SELECT level FROM db_pigeon_alert_levels
          WHERE user_id = $3 AND ((conversation_id = $2 AND $2 IS NOT NULL) OR (contact_id = $1 AND $1 IS NOT NULL) OR (contact_id IS NULL AND conversation_id IS NULL))
          ORDER BY (conversation_id IS NOT NULL) DESC, (contact_id IS NOT NULL) DESC LIMIT 1",
    )
    .bind(contact)
    .bind(conversation)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    Ok(own.as_deref().and_then(Level::parse).unwrap_or(Level::Smart))
}

/// The level of a conversation, by its id.
pub async fn of_conversation(pool: &DbPool, conversation: Uuid) -> anyhow::Result<Level> {
    let row: Option<(String, Option<Uuid>)> = sqlx::query_as("SELECT user_id, contact_id FROM db_pigeon_conversations WHERE id = $1")
        .bind(conversation)
        .fetch_optional(pool)
        .await?;
    let Some((user, contact)) = row else { return Ok(Level::Smart) };
    resolve(pool, &user, contact, Some(conversation)).await
}

/// A contact's, a conversation's or the user's default (both None) level; None: back to the one
/// above. A contact's is theirs everywhere: their conversations' own go.
pub async fn set(pool: &DbPool, user: &str, contact: Option<Uuid>, conversation: Option<Uuid>, level: Option<Level>) -> anyhow::Result<()> {
    let (contact, conversation) = if conversation.is_some() { (None, conversation) } else { (contact, None) };
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM db_pigeon_alert_levels WHERE user_id = $3 AND contact_id IS NOT DISTINCT FROM $1 AND conversation_id IS NOT DISTINCT FROM $2")
        .bind(contact)
        .bind(conversation)
        .bind(user)
        .execute(&mut *tx)
        .await?;
    if let Some(c) = contact {
        sqlx::query("DELETE FROM db_pigeon_alert_levels WHERE conversation_id IN (SELECT id FROM db_pigeon_conversations WHERE contact_id = $1)").bind(c).execute(&mut *tx).await?;
    }
    if let Some(l) = level {
        sqlx::query("INSERT INTO db_pigeon_alert_levels (user_id, contact_id, conversation_id, level) VALUES ($4, $1, $2, $3)")
            .bind(contact)
            .bind(conversation)
            .bind(l.as_str())
            .bind(user)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn urgent_beats_the_switch() {
        assert_eq!(for_brief(Level::Off, true), Delivery::Ring);
        assert_eq!(for_brief(Level::Off, false), Delivery::Skip);
        assert_eq!(for_brief(Level::Quiet, false), Delivery::Silent);
        assert_eq!(for_brief(Level::Smart, false), Delivery::Ring);
        assert_eq!(for_message(Level::Smart), Delivery::Silent);
        assert_eq!(for_message(Level::All), Delivery::Ring);
        assert_eq!(for_message(Level::Off), Delivery::Skip);
        assert_eq!(Level::parse("Quiet"), Some(Level::Quiet));
    }
}

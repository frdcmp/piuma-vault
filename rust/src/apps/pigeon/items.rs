//! Taking an item in: whatever a connector received, as one row in a conversation, with the
//! person behind it found or made. Idempotent on (conversation, external_id): a connector may
//! hand the same message twice (a re-poll, a retried webhook) and it is stored once.

use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::Value as Json;
use uuid::Uuid;

use crate::apps::pigeon::events::kinds as events_kind;
use crate::db::db::DbPool;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction {
    In,
    Out,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Author {
    /// the other person
    Them,
    /// the user, from their phone or mail client, or the Inbox
    Me,
    /// Pigeon, by an action
    Pigeon,
}

impl Author {
    pub fn as_str(self) -> &'static str {
        match self {
            Author::Them => "them",
            Author::Me => "me",
            Author::Pigeon => "pigeon",
        }
    }
}

/// One message as a connector hands it over.
#[derive(Debug, Clone)]
pub struct Incoming {
    /// whose: the connection's user
    pub user_id: String,
    pub connector: &'static str,
    pub connection_id: Option<i32>,
    /// The thread on its channel (a Gmail thread id, a WhatsApp chat).
    pub thread: String,
    pub thread_title: Option<String>,
    pub external_id: String,
    pub direction: Direction,
    pub author: Author,
    pub sender: Option<String>,
    pub sender_name: Option<String>,
    pub subject: Option<String>,
    pub body: String,
    pub media: Json,
    pub raw: Json,
    pub at: DateTime<Utc>,
    /// The other person on the thread (handle, name): who the conversation is with.
    pub counterpart: Option<(String, Option<String>)>,
    /// The channel's reply window after their message (WhatsApp, Instagram: 24 h), if any.
    pub window: Option<Duration>,
    /// Triage this after the debounce (false for history brought in on connect).
    pub triage: bool,
}

pub struct Ingested {
    pub conversation_id: Uuid,
}

/// The username in a display name written "@user" or "Name (@user)", lowercased.
fn username(name: Option<&str>) -> Option<String> {
    let n = name?.trim();
    let u = n.strip_prefix('@').or_else(|| n.strip_suffix(')').and_then(|n| n.rsplit_once("(@")).map(|(_, u)| u))?;
    (!u.is_empty() && u.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_')).then(|| u.to_lowercase())
}

/// Store one item. None when it was stored already.
pub async fn ingest(pool: &DbPool, inc: &Incoming, debounce: Duration) -> anyhow::Result<Option<Ingested>> {
    let mut tx = pool.begin().await?;
    let (conversation_id, contact_id): (Uuid, Option<Uuid>) = sqlx::query_as(
        "INSERT INTO db_pigeon_conversations (user_id, connection_id, connector, external_id, title)
         VALUES ($5, $1, $2, $3, $4)
         ON CONFLICT (user_id, connector, external_id) DO UPDATE
           SET title = COALESCE(db_pigeon_conversations.title, EXCLUDED.title),
               connection_id = COALESCE(EXCLUDED.connection_id, db_pigeon_conversations.connection_id)
         RETURNING id, contact_id",
    )
    .bind(inc.connection_id)
    .bind(inc.connector)
    .bind(&inc.thread)
    .bind(&inc.thread_title)
    .bind(&inc.user_id)
    .fetch_one(&mut *tx)
    .await?;

    if contact_id.is_none() {
        if let Some((handle, name)) = &inc.counterpart {
            let handle = handle.trim().to_lowercase();
            let found: Option<Uuid> = sqlx::query_scalar("SELECT contact_id FROM db_pigeon_contact_handles WHERE user_id = $3 AND connector = $1 AND handle = $2")
                .bind(inc.connector)
                .bind(&handle)
                .bind(&inc.user_id)
                .fetch_optional(&mut *tx)
                .await?;
            // not by this handle: by a username known ahead ("@valeriomorini", set from the vault
            // before they ever wrote), which the handle then joins
            let found = match (found, username(name.as_deref())) {
                (None, Some(u)) => {
                    let by_name: Option<Uuid> = sqlx::query_scalar("SELECT contact_id FROM db_pigeon_contact_handles WHERE user_id = $3 AND connector = $1 AND handle = $2")
                        .bind(inc.connector)
                        .bind(format!("@{u}"))
                        .bind(&inc.user_id)
                        .fetch_optional(&mut *tx)
                        .await?;
                    if let Some(c) = by_name {
                        sqlx::query("INSERT INTO db_pigeon_contact_handles (user_id, connector, handle, contact_id, display_name) VALUES ($5, $1, $2, $3, $4) ON CONFLICT DO NOTHING")
                            .bind(inc.connector)
                            .bind(&handle)
                            .bind(c)
                            .bind(name)
                            .bind(&inc.user_id)
                            .execute(&mut *tx)
                            .await?;
                    }
                    by_name
                }
                (found, _) => found,
            };
            let contact = match found {
                Some(c) => c,
                None => {
                    let c: Uuid = sqlx::query_scalar("INSERT INTO db_pigeon_contacts (user_id, name) VALUES ($2, $1) RETURNING id")
                        .bind(name.as_deref().filter(|n| !n.trim().is_empty()).unwrap_or(&handle))
                        .bind(&inc.user_id)
                        .fetch_one(&mut *tx)
                        .await?;
                    sqlx::query("INSERT INTO db_pigeon_contact_handles (user_id, connector, handle, contact_id, display_name) VALUES ($5, $1, $2, $3, $4)")
                        .bind(inc.connector)
                        .bind(&handle)
                        .bind(c)
                        .bind(name)
                        .bind(&inc.user_id)
                        .execute(&mut *tx)
                        .await?;
                    c
                }
            };
            sqlx::query("UPDATE db_pigeon_conversations SET contact_id = $1 WHERE id = $2").bind(contact).bind(conversation_id).execute(&mut *tx).await?;
        }
    }

    let item_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO db_pigeon_items (conversation_id, connector, external_id, direction, author, sender, sender_name, subject, body, media, raw, at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (conversation_id, external_id) DO NOTHING
         RETURNING id",
    )
    .bind(conversation_id)
    .bind(inc.connector)
    .bind(&inc.external_id)
    .bind(if inc.direction == Direction::In { "in" } else { "out" })
    .bind(inc.author.as_str())
    .bind(&inc.sender)
    .bind(&inc.sender_name)
    .bind(&inc.subject)
    .bind(&inc.body)
    .bind(&inc.media)
    .bind(&inc.raw)
    .bind(inc.at)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(item_id) = item_id else {
        tx.rollback().await?;
        return Ok(None);
    };

    sqlx::query("UPDATE db_pigeon_conversations SET last_item_at = GREATEST(last_item_at, $2), updated_at = NOW() WHERE id = $1")
        .bind(conversation_id)
        .bind(inc.at)
        .execute(&mut *tx)
        .await?;
    match (inc.direction, inc.author) {
        (Direction::In, _) => {
            let window_until = inc.window.map(|w| inc.at + chrono::Duration::from_std(w).unwrap_or_default());
            let due = inc.triage.then(|| Utc::now() + chrono::Duration::from_std(debounce).unwrap_or_default());
            // history (brought in on connect, or gathered) counts as seen: the next triage starts
            // after it; unless a triage is waiting, which must still see what it was queued for
            sqlx::query(
                "UPDATE db_pigeon_conversations
                    SET last_in_at = GREATEST(last_in_at, $2),
                        window_until = COALESCE($3, window_until),
                        triage_due_at = COALESCE($4, triage_due_at),
                        triaged_at = CASE WHEN $5 OR triage_due_at IS NOT NULL THEN triaged_at ELSE GREATEST(triaged_at, NOW()) END
                  WHERE id = $1",
            )
            .bind(conversation_id)
            .bind(inc.at)
            .bind(window_until)
            .bind(due)
            .bind(inc.triage)
            .execute(&mut *tx)
            .await?;
        }
        (Direction::Out, author) => {
            sqlx::query("UPDATE db_pigeon_conversations SET last_out_at = GREATEST(last_out_at, $2) WHERE id = $1")
                .bind(conversation_id)
                .bind(inc.at)
                .execute(&mut *tx)
                .await?;
            // the user answered themselves: the conversation is handled, and a reply Pigeon was
            // still proposing is stale.
            if author == Author::Me && inc.triage {
                sqlx::query("UPDATE db_pigeon_conversations SET attention = NULL, needs_note = NULL, handled_at = NOW(), triage_due_at = NULL WHERE id = $1")
                    .bind(conversation_id)
                    .execute(&mut *tx)
                    .await?;
                sqlx::query(
                    "UPDATE db_pigeon_actions SET status = 'expired', error = 'replied themselves', updated_at = NOW()
                      WHERE conversation_id = $1 AND status = 'pending' AND kind = 'reply'",
                )
                .bind(conversation_id)
                .execute(&mut *tx)
                .await?;
                // and what Pigeon was asking them about it (its card goes)
                sqlx::query("UPDATE db_pigeon_questions SET status = 'expired' WHERE conversation_id = $1 AND status = 'open'")
                    .bind(conversation_id)
                    .execute(&mut *tx)
                    .await?;
            }
        }
    }
    tx.commit().await?;
    log::debug!("pigeon item {item_id} in {conversation_id}");
    // its photos, videos and files, into storage
    crate::apps::pigeon::media::fetch_soon(pool, item_id, &inc.media);
    // someone known only by number whose message carries their name takes it
    if inc.direction == Direction::In {
        if let Some((_, Some(name))) = &inc.counterpart {
            let st = crate::apps::pigeon::state::shared(pool);
            if let Err(e) = crate::apps::pigeon::people::name_from_message(&st, conversation_id, name).await {
                log::warn!("pigeon: naming the person of {conversation_id}: {e:#}");
            }
        }
    }
    crate::apps::pigeon::events::publish(pool, &inc.user_id, "conversation", Some(conversation_id)).await;
    // a new message from them: the worker pushes it to the phone, by their alert switch
    if inc.direction == Direction::In && inc.triage {
        crate::apps::pigeon::events::publish(pool, &inc.user_id, events_kind::MESSAGE_IN, Some(item_id)).await;
    }
    Ok(Some(Ingested { conversation_id }))
}

/// The user's own words sent through Pigeon (written in the Inbox): the item is theirs (`via`
/// "inbox": not from their phone); the conversation is handled, what Pigeon proposed or asked there is stale,
/// and Pigeon steps back there for a while (actions::user_writing).
pub async fn mark_mine(pool: &DbPool, item: Uuid) -> anyhow::Result<()> {
    let mut tx = pool.begin().await?;
    let conversation: Uuid = sqlx::query_scalar("UPDATE db_pigeon_items SET author = 'me', raw = COALESCE(raw, '{}'::jsonb) || '{\"via\": \"inbox\"}' WHERE id = $1 RETURNING conversation_id").bind(item).fetch_one(&mut *tx).await?;
    sqlx::query("UPDATE db_pigeon_conversations SET attention = NULL, needs_note = NULL, handled_at = NOW(), triage_due_at = NULL WHERE id = $1").bind(conversation).execute(&mut *tx).await?;
    sqlx::query(
        "UPDATE db_pigeon_actions SET status = 'expired', error = 'replied themselves', updated_at = NOW()
          WHERE conversation_id = $1 AND status = 'pending' AND kind = 'reply'",
    )
    .bind(conversation)
    .execute(&mut *tx)
    .await?;
    sqlx::query("UPDATE db_pigeon_questions SET status = 'expired' WHERE conversation_id = $1 AND status = 'open'").bind(conversation).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

/// They're still writing (a channel that tells, WhatsApp): the triage waiting on the conversation
/// waits for them to finish, a debounce from now.
pub async fn still_writing(pool: &DbPool, user: &str, connector: &str, thread: &str, debounce: Duration) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE db_pigeon_conversations SET triage_due_at = GREATEST(triage_due_at, NOW() + make_interval(secs => $3))
          WHERE user_id = $4 AND connector = $1 AND external_id = $2 AND triage_due_at IS NOT NULL",
    )
    .bind(connector)
    .bind(thread)
    .bind(debounce.as_secs_f64())
    .bind(user)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::username;

    #[test]
    fn a_username_from_a_display_name() {
        assert_eq!(username(Some("@xordi.x")), Some("xordi.x".into()));
        assert_eq!(username(Some("Valerio Morini (@ValerioMorini)")), Some("valeriomorini".into()));
        assert_eq!(username(Some("Valerio Morini")), None);
        assert_eq!(username(Some("someone@example.com")), None);
        assert_eq!(username(Some("@")), None);
        assert_eq!(username(None), None);
    }
}

/// An emoji someone put on a message, or took off (`emoji` None): kept on the message, one per
/// person (`who`: their handle; "me" for the user, from any of their devices). False: no such
/// message here (one from before Pigeon, or not kept).
#[allow(clippy::too_many_arguments)]
pub async fn react(pool: &DbPool, user: &str, connector: &str, target: &str, who: &str, me: bool, name: Option<&str>, emoji: Option<&str>, at: DateTime<Utc>) -> anyhow::Result<bool> {
    let key = if me { "me" } else { who };
    let set = emoji.filter(|e| !e.trim().is_empty()).map(|e| serde_json::json!({ "emoji": e, "at": at, "me": me, "name": name }));
    let found: Option<Uuid> = sqlx::query_scalar(
        "UPDATE db_pigeon_items i
            SET raw = jsonb_set(COALESCE(i.raw, '{}'::jsonb), '{reactions}',
                  CASE WHEN $5::jsonb IS NULL THEN COALESCE(i.raw->'reactions', '{}'::jsonb) - $4
                       ELSE COALESCE(i.raw->'reactions', '{}'::jsonb) || jsonb_build_object($4, $5::jsonb) END)
           FROM db_pigeon_conversations c
          WHERE c.id = i.conversation_id AND c.user_id = $1 AND i.connector = $2 AND i.external_id = $3
          RETURNING i.conversation_id",
    )
    .bind(user)
    .bind(connector)
    .bind(target)
    .bind(key)
    .bind(set)
    .fetch_optional(pool)
    .await?;
    if let Some(conversation) = found {
        crate::apps::pigeon::events::publish(pool, user, "conversation", Some(conversation)).await;
    }
    Ok(found.is_some())
}

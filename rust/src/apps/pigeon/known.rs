//! What Pigeon knows about a person: facts in the vault's memory (`agents::tools::memory`), each
//! about one of the user's contacts, under the same rules as what Piuma knows about the user:
//!
//!   - what the person said about themselves is confirmed (`person_stated`); what Pigeon reads
//!     between the lines is a guess, pending for 60 days (`pigeon_derived`), confirmed when the
//!     user says so, or when new messages, a day or more later, show it again
//!   - a fact that contradicts a confirmed one waits, pending, for the user
//!   - what's open between them (a question waiting, a promise, a plan) is a goal: it holds 60
//!     days from when it last came up
//!
//! Learnt every few items with the person (`learn`), from the messages since the last time, with
//! what is already known in front of the model, so it adds, and points at what it sees again.
//! Read whole wherever Pigeon works in their chats (`told`): a handful of lines per person. The
//! user sees them on the person's page, and confirms, rejects or deletes them there.
//!
//! Only about that person, only in their chats: never about anyone else, never Piuma's facts
//! about the user, never to the Notes tool. What Pigeon may tell people is a permission
//! (`access`), not a fact.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::agents::tools::memory::{self, Person};
use crate::apps::pigeon::ai::llm;
use crate::apps::pigeon::conversations::{self, Contact};
use crate::apps::pigeon::folder;
use crate::apps::pigeon::owner;
use crate::apps::pigeon::people;
use crate::apps::pigeon::state::State;
use crate::db::db::DbPool;

/// Whose memory the facts are in: the vault's agent's, Piuma's (it reads them when asked).
pub const AGENT: &str = "vault_agent";
/// Learnt once there are this many items with the person, then after this many more (or, with
/// any new one, after a while: `people::due`).
const MIN_ITEMS: i64 = 2;
const EVERY: i64 = 6;
/// What it learns from: their latest conversations, the latest items of each.
const CONVERSATIONS: i64 = 12;
const ITEMS_EACH: i64 = 12;

/// One fact about a person.
#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Fact {
    pub id: Uuid,
    pub content: String,
    /// who (who they are to the user), fact, preference, goal (what's open between them)
    pub category: Option<String>,
    /// confirmed or pending
    pub status: String,
    /// person_stated, pigeon_derived, imported (from the notes Pigeon kept before)
    pub source: String,
    /// how a confirmed one was: stated, corroborated, user, imported
    pub confirmed_by: Option<String>,
    pub created_at: DateTime<Utc>,
    pub expires_at: Option<DateTime<Utc>>,
}

/// The categories, in the order a person's facts are shown, with what each holds.
const CATEGORIES: &[(&str, &str)] = &[
    ("who", "who they are to the user: friend, family, client, colleague, a company"),
    ("fact", "a fact worth remembering: names, places, dates, their work, their family"),
    ("preference", "what they like or how they want things, the language they use"),
    ("goal", "what is open between them: a question waiting, a promise, a plan"),
];

/// What is known about a person: confirmed and pending, not expired, by category.
pub async fn of(pool: &DbPool, contact: Uuid) -> anyhow::Result<Vec<Fact>> {
    Ok(sqlx::query_as(
        "SELECT id, content, category, status, source, confirmed_by, created_at, expires_at FROM db_memory_entries
          WHERE contact_id = $1 AND is_active AND status IN ('confirmed', 'pending') AND (expires_at IS NULL OR expires_at > NOW())
          ORDER BY array_position(ARRAY['who', 'fact', 'preference', 'goal'], category), created_at",
    )
    .bind(contact)
    .fetch_all(pool)
    .await?)
}

/// The facts as a model reads them: one line each, a guess marked, what's open marked.
pub fn lines(facts: &[Fact]) -> String {
    facts
        .iter()
        .map(|f| {
            let open = if f.category.as_deref() == Some("goal") { "Open: " } else { "" };
            let unsure = if f.status == "pending" { " (a guess, not confirmed)" } else { "" };
            format!("- {open}{}{unsure}", f.content)
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// What Pigeon knows about a person, as it reads it in their chats; none when nothing is.
pub async fn told(pool: &DbPool, contact: Uuid) -> anyhow::Result<Option<String>> {
    let facts = of(pool, contact).await?;
    Ok((!facts.is_empty()).then(|| lines(&facts)))
}

/// One of a contact's facts, theirs: the fact's id, when it is about that contact.
async fn own(pool: &DbPool, contact: Uuid, fact: Uuid) -> anyhow::Result<()> {
    let ok: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM db_memory_entries WHERE id = $1 AND contact_id = $2)")
        .bind(fact)
        .bind(contact)
        .fetch_one(pool)
        .await?;
    if !ok {
        anyhow::bail!("no such fact about this person: {fact}");
    }
    Ok(())
}

/// The user's word on a fact about one of their contacts: `confirm` (it's true), `reject` (it
/// isn't: it stops being used), `delete` (gone). `by`: `user` (their tap), `chat` (an assistant,
/// on their word).
pub async fn judge(st: &State, user: &str, contact: Uuid, fact: Uuid, verdict: &str, by: &str) -> anyhow::Result<Json> {
    people::mine(st, user, contact).await?;
    own(&st.pool, contact, fact).await?;
    match verdict {
        "confirm" => {
            memory::confirm(&st.pool, fact, None, by).await?;
        }
        "reject" => {
            sqlx::query("UPDATE db_memory_entries SET status = 'rejected', is_active = FALSE, updated_at = NOW() WHERE id = $1").bind(fact).execute(&st.pool).await?;
        }
        "delete" => {
            sqlx::query("DELETE FROM db_memory_entries WHERE id = $1").bind(fact).execute(&st.pool).await?;
        }
        other => anyhow::bail!("confirm, reject or delete, not {other}"),
    }
    crate::apps::pigeon::events::publish(&st.pool, user, "contact", Some(contact)).await;
    Ok(json!({ "fact": fact, "done": verdict, "facts": of(&st.pool, contact).await? }))
}

/// A person merged into another: their facts are the kept one's.
pub async fn merged(tx: &mut sqlx::PgConnection, keep: Uuid, other: Uuid) -> anyhow::Result<u64> {
    Ok(sqlx::query("UPDATE db_memory_entries SET contact_id = $1, updated_at = NOW() WHERE contact_id = $2")
        .bind(keep)
        .bind(other)
        .execute(tx)
        .await?
        .rows_affected())
}

/// What the model answers, line by line: a new fact (`[category] text`, `[category, theirs]` when
/// the person said it about themselves), or a known one the new messages show again (`= n`).
#[derive(Debug, PartialEq)]
enum Said {
    New { category: String, text: String, theirs: bool },
    Again(usize),
}

fn said(raw: &str) -> Vec<Said> {
    raw.lines()
        .filter_map(|l| {
            let l = l.trim().trim_start_matches(['-', '*', ' ']);
            if let Some(n) = l.strip_prefix('=') {
                return n.trim().parse().ok().map(Said::Again);
            }
            let (tag, text) = l.strip_prefix('[')?.split_once(']')?;
            let mut tag = tag.split(',').map(|t| t.trim().to_lowercase());
            let category = tag.next().filter(|c| CATEGORIES.iter().any(|(k, _)| k == c))?;
            let theirs = tag.any(|t| t == "theirs");
            let text = text.trim();
            (!text.is_empty()).then(|| Said::New { category, text: text.to_string(), theirs })
        })
        .collect()
}

/// When it was last learnt: the items with them then, and when.
async fn last(pool: &DbPool, contact: Uuid) -> anyhow::Result<(Option<i32>, Option<DateTime<Utc>>)> {
    Ok(sqlx::query_as("SELECT learned_items, learned_at FROM db_pigeon_contacts WHERE id = $1").bind(contact).fetch_one(pool).await?)
}

/// Learn about this person from their messages since the last time, when due (or `force`). True
/// when something was added or seen again.
pub async fn learn(st: &State, c: &Contact, force: bool) -> anyhow::Result<bool> {
    let n = people::count_items(st, c.id).await?;
    if n < MIN_ITEMS {
        return Ok(false);
    }
    let (then_items, then) = last(&st.pool, c.id).await?;
    if !force {
        if let (Some(items), Some(at)) = (then_items, then) {
            if !people::due(n, items, at, EVERY) {
                return Ok(false);
            }
        }
    }
    if !llm::available(&st.pool).await {
        return Ok(false);
    }
    let owner = owner::get(&st.pool, &c.user_id).await;
    let name = owner.name.clone();
    let handles = conversations::my_handles(&st.pool, &c.user_id).await?;
    let me = (name.as_str(), handles.as_slice());
    let them = c.name.clone().unwrap_or_else(|| "this person".into());
    let convs: Vec<conversations::Conversation> = sqlx::query_as(&format!(
        "SELECT {} FROM db_pigeon_conversations WHERE contact_id = $1 AND last_item_at > COALESCE($3, '-infinity') ORDER BY last_item_at DESC LIMIT $2",
        conversations::CONVERSATION_COLS
    ))
    .bind(c.id)
    .bind(CONVERSATIONS)
    .bind(then)
    .fetch_all(&st.pool)
    .await?;
    // only what came since: the evidence is new, so what it shows again counts
    let mut text = String::new();
    for conv in &convs {
        let items: Vec<conversations::Item> =
            conversations::recent_items(&st.pool, conv.id, ITEMS_EACH).await?.into_iter().filter(|i| then.is_none_or(|t| i.at > t)).collect();
        if items.is_empty() {
            continue;
        }
        text.push_str(&format!(
            "\n=== {} conversation{}\n{}",
            conv.connector,
            conv.title.as_deref().filter(|t| !t.is_empty()).map(|t| format!(" \"{t}\"")).unwrap_or_default(),
            conversations::transcript(&items, &them, me, 500)
        ));
    }
    let done = |pool: DbPool, id: Uuid| async move {
        sqlx::query("UPDATE db_pigeon_contacts SET learned_items = $2, learned_at = NOW() WHERE id = $1").bind(id).bind(n as i32).execute(&pool).await
    };
    if text.trim().is_empty() {
        done(st.pool.clone(), c.id).await?;
        return Ok(false);
    }
    let known = of(&st.pool, c.id).await?;
    let mut prompt = format!("The person: {them}\n{}", c.facts(&name));
    if let Some(note) = c.note.as_deref().filter(|n| !n.trim().is_empty()) {
        prompt.push_str(&format!("{name}'s own note on them (true, keep it in mind): {note}\n"));
    }
    if known.is_empty() {
        prompt.push_str("\nWhat is known about them: nothing yet.\n");
    } else {
        prompt.push_str("\nWhat is known about them already, numbered:\n");
        for (i, f) in known.iter().enumerate() {
            prompt.push_str(&format!("{}. [{}] {}\n", i + 1, f.category.as_deref().unwrap_or("fact"), f.content));
        }
    }
    prompt.push_str(&format!("\nTheir new messages with {name}, each conversation oldest first:\n{text}"));
    let kinds = CATEGORIES.iter().map(|(k, holds)| format!("  [{k}] {holds}")).collect::<Vec<_>>().join("\n");
    let raw = llm::text_of(
        &st.pool,
        "memory",
        &format!(
            "You keep Pigeon's memory of one person {name} talks to, so {name}'s replies to them make sense. From their \
             new messages, write what is worth remembering about them that isn't known already, one short fact per line, in \
             English, each with its kind:\n{kinds}\nAdd \", theirs\" to the kind when the person said it about themselves \
             (\"[fact, theirs] Works as a nurse in Milan\"); leave it out for what you read between the lines. For a known \
             fact the new messages show again, write \"= <its number>\". Only what the messages show: never guess beyond \
             them, never repeat a known fact in other words. Nothing worth adding: answer nothing. No preamble."
        ),
        &prompt,
    )
    .await?;
    let person = Person { user: &c.user_id, contact: c.id };
    let (mut added, mut again) = (0, 0);
    for s in said(&raw) {
        match s {
            Said::New { category, text, theirs } => match memory::save_about(&st.pool, AGENT, person, &text, Some(&category), theirs).await {
                Ok("inserted") | Ok("corroborated") => added += 1,
                Ok(_) => {}
                Err(e) => log::warn!("pigeon: a fact about {}: {e}", c.id),
            },
            Said::Again(i) => {
                let Some(f) = i.checked_sub(1).and_then(|i| known.get(i)) else { continue };
                again += 1;
                // new messages, a day or more on, show a guess again: it's confirmed
                if f.status == "pending" && Utc::now() - f.created_at >= chrono::Duration::days(memory::INDEPENDENT_DAYS as i64) {
                    memory::confirm(&st.pool, f.id, None, "corroborated").await?;
                } else {
                    memory::renew(&st.pool, f.id).await;
                }
            }
        }
    }
    done(st.pool.clone(), c.id).await?;
    if added + again > 0 {
        crate::apps::pigeon::events::publish(&st.pool, &c.user_id, "contact", Some(c.id)).await;
    }
    log::info!("pigeon: learnt about {}: {added} new, {again} seen again", c.id);
    Ok(added + again > 0)
}

/// One-off (`pigeon-worker facts-from-notes`): the Memory notes Pigeon kept on people, as facts.
/// Each note's lines are sorted into kinds by the model (their words kept, a line holding two
/// facts split), saved confirmed (`imported`: Pigeon has been using them), and the note goes to
/// the trash. What the note was written from carries over, so learning goes on from there. A
/// note done isn't one any more: it can be run again.
pub async fn from_notes(st: &State) -> anyhow::Result<Json> {
    let rows: Vec<(Uuid, String, Uuid, i32, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT p.note_id, p.user_id, p.contact_id, p.items, p.written_at, n.content
           FROM db_pigeon_person_notes p JOIN notes n ON n.id = p.note_id
          WHERE p.kind = 'memory' AND p.contact_id IS NOT NULL AND n.deleted_at IS NULL",
    )
    .fetch_all(&st.pool)
    .await?;
    let kinds = CATEGORIES.iter().map(|(k, holds)| format!("  [{k}] {holds}")).collect::<Vec<_>>().join("\n");
    let (mut notes, mut facts) = (0, 0);
    for (note_id, user, contact, items, written_at, content) in rows {
        let body = folder::body(&content);
        let raw = llm::text_of(
            &st.pool,
            "memory",
            &format!(
                "Below is a note of what is known about one person. Rewrite it as one fact per line, each with its kind:\n\
                 {kinds}\nKeep the note's words; split a line that holds two facts; drop nothing but headings. No preamble."
            ),
            body,
        )
        .await?;
        let lines = said(&raw);
        if lines.is_empty() && !body.trim().is_empty() {
            anyhow::bail!("note {note_id}: the model gave no facts back");
        }
        let mut tx = st.pool.begin().await?;
        for s in &lines {
            let Said::New { category, text, .. } = s else { continue };
            sqlx::query(
                "INSERT INTO db_memory_entries (agent, user_id, contact_id, content, category, confidence, source, status, confirmed_by, confirmed_at, expires_at)
                 VALUES ($1, $2, $3, $4, $5, 'high', 'imported', 'confirmed', 'imported', NOW(),
                         CASE WHEN $5 = 'goal' THEN NOW() + make_interval(days => $6) END)",
            )
            .bind(AGENT)
            .bind(&user)
            .bind(contact)
            .bind(text)
            .bind(category)
            .bind(memory::GOAL_DAYS)
            .execute(&mut *tx)
            .await?;
            facts += 1;
        }
        // embedded by the worker, like any fact saved while the provider was down
        sqlx::query(
            "INSERT INTO db_memory_embedding_jobs (memory_entry_id, content)
             SELECT id, content FROM db_memory_entries WHERE contact_id = $1 AND source = 'imported' AND embedding IS NULL
               AND NOT EXISTS (SELECT 1 FROM db_memory_embedding_jobs j WHERE j.memory_entry_id = db_memory_entries.id)",
        )
        .bind(contact)
        .execute(&mut *tx)
        .await?;
        sqlx::query("UPDATE db_pigeon_contacts SET learned_items = $2, learned_at = $3 WHERE id = $1").bind(contact).bind(items).bind(written_at).execute(&mut *tx).await?;
        crate::apps::notes::versions::set_change_source(&mut tx, "pigeon").await?;
        sqlx::query("DELETE FROM db_pigeon_person_notes WHERE note_id = $1").bind(note_id).execute(&mut *tx).await?;
        sqlx::query("UPDATE notes SET deleted_at = NOW() WHERE id = $1").bind(note_id).execute(&mut *tx).await?;
        tx.commit().await?;
        notes += 1;
        log::info!("facts-from-notes: {contact}: {} facts", lines.len());
    }
    Ok(json!({ "notes": notes, "facts": facts }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_answer_reads_as_new_facts_and_ones_seen_again() {
        let raw = "- [fact, theirs] Works as a nurse in Milan\n[goal] Owes the user a call about the trip\n= 2\n[weather] sunny\nsome prose";
        assert_eq!(
            said(raw),
            vec![
                Said::New { category: "fact".into(), text: "Works as a nurse in Milan".into(), theirs: true },
                Said::New { category: "goal".into(), text: "Owes the user a call about the trip".into(), theirs: false },
                Said::Again(2),
            ]
        );
    }
}

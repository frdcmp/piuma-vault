//! A person's folder in the vault: what Pigeon knows about someone is notes in
//! `/contacts/<person>/`, next to the user's own notes on them, read and edited like any note.
//!
//!   Pigeon · Memory             who they are to the user, what's going on, what's open
//!   Pigeon · Style · WhatsApp   how the user writes to them there, one per channel
//!   Pigeon · Style              a group chat's (its folder is in `/contacts` too, named after it)
//!
//! Whose folder: the one of the note linked to the person (`note_id`) when it is a folder of
//! `/contacts`, else where Pigeon's notes on them already are, else one named after them, made by
//! the first note written there. `db_pigeon_person_notes` keeps each note's id (a renamed or moved
//! folder loses nothing) and a hash of what Pigeon last wrote: a note that differs was edited by
//! the user, and their words are the base of the next rewrite (`people`). A write is a write to
//! the notes table like any other: the trigger keeps every rewrite in the note's history (source
//! "pigeon") and the note is embedded again.
//!
//! Nothing in `/contacts` is ever shared with the Notes tool (`access`, `tell`).

use chrono::{DateTime, Utc};
use sha2::{Digest, Sha256};
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::notes::versions;
use crate::apps::pigeon::conversations::{Contact, Conversation};
use crate::apps::pigeon::owner::Owner;
use crate::apps::pigeon::slugs;
use crate::apps::pigeon::state::State;

/// Where people's folders are.
pub const ROOT: &str = "/contacts";
/// The line at the top of a note Pigeon keeps.
const MARK: &str = "Pigeon keeps this note";
/// Its tag.
const TAG: &str = "pigeon";
/// The user's own notes on someone, read with a reply: this many characters in all, the newest first.
const OWN_NOTES: usize = 6000;
/// Of them, this many notes at most.
const OWN_NOTES_MAX: i64 = 30;
/// A group chat's folder name is this long at most.
const NAME_MAX: usize = 40;

pub const MEMORY: &str = "memory";
pub const STYLE: &str = "style";

/// Whether a folder is `/contacts` or in it: private, never shared.
pub fn private(folder: &str) -> bool {
    let f = folder.trim_end_matches('/');
    f == ROOT || f.starts_with("/contacts/")
}

/// Whether a folder is someone's: one in `/contacts`, not `/contacts` itself.
pub fn someones(folder: &str) -> bool {
    folder.trim_end_matches('/').len() > ROOT.len() + 1 && folder.starts_with("/contacts/")
}

/// `folder LIKE` this: what is under it (its own wildcards escaped).
pub fn under(folder: &str) -> String {
    format!("{}/%", folder.trim_end_matches('/').replace('\\', "\\\\").replace('%', "\\%").replace('_', "\\_"))
}

/// Whose notes: a person's, or a group chat's.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Whose {
    Person(Uuid),
    Chat(Uuid),
}

impl Whose {
    fn id(self) -> Uuid {
        match self {
            Whose::Person(id) | Whose::Chat(id) => id,
        }
    }
}

/// A note Pigeon keeps, as it stands in the vault.
#[derive(Debug, Clone, FromRow)]
pub struct Kept {
    pub note_id: Uuid,
    pub kind: String,
    /// a style's channel (a group chat's style has none)
    pub connector: Option<String>,
    pub written_hash: String,
    pub written_at: DateTime<Utc>,
    /// what it was written from: the items with the person (memory), the user's messages (style)
    pub items: i32,
    pub content: String,
    pub folder: String,
}

impl Kept {
    /// What it says, without Pigeon's line at the top.
    pub fn body(&self) -> &str {
        body(&self.content)
    }

    /// Whether the user changed it since Pigeon wrote it.
    pub fn edited(&self) -> bool {
        hash(&self.content) != self.written_hash
    }
}

const KEPT: &str = "SELECT p.note_id, p.kind, p.connector, p.written_hash, p.written_at, p.items, n.content, n.folder
       FROM db_pigeon_person_notes p JOIN notes n ON n.id = p.note_id AND n.deleted_at IS NULL";

/// Pigeon's notes on a person or a group chat (those in the trash aren't there).
pub async fn kept(st: &State, whose: Whose) -> anyhow::Result<Vec<Kept>> {
    Ok(sqlx::query_as(&format!("{KEPT} WHERE COALESCE(p.contact_id, p.conversation_id) = $1 ORDER BY p.kind, p.connector"))
        .bind(whose.id())
        .fetch_all(&st.pool)
        .await?)
}

/// One of them: the memory, or a channel's style (a group chat's: no channel).
pub async fn one(st: &State, whose: Whose, kind: &str, connector: Option<&str>) -> anyhow::Result<Option<Kept>> {
    Ok(kept(st, whose).await?.into_iter().find(|k| k.kind == kind && k.connector.as_deref() == connector))
}

/// The line at the top: whose note it is and when Pigeon last wrote it, in the user's time.
fn header(me: &Owner, at: Option<DateTime<Utc>>) -> String {
    format!("*{MARK} · last written {}*", me.local(at.unwrap_or_else(Utc::now)).format("%Y-%m-%d %H:%M"))
}

/// A note's words without Pigeon's line at the top (a note whose line the user removed: all of it).
pub fn body(content: &str) -> &str {
    let text = content.trim_start();
    match text.split_once('\n') {
        Some((first, rest)) if first.contains(MARK) => rest.trim(),
        None if text.contains(MARK) => "",
        _ => text.trim_end(),
    }
}

/// What a note says, as a hash: of its words, so the line at the top and the spacing don't count.
pub fn hash(content: &str) -> String {
    let words = body(content).split_whitespace().collect::<Vec<_>>().join(" ");
    hex::encode(Sha256::digest(words.as_bytes()))
}

/// A folder's name from a title: lowercase letters and digits (of any script), dashes between.
pub fn name_of(title: &str) -> String {
    let mut out = String::new();
    for c in title.to_lowercase().chars() {
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.chars().take(NAME_MAX).collect::<String>().trim_end_matches('-').to_string()
}

async fn holds_notes(st: &State, user: &str, folder: &str) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM notes WHERE user_id = $1 AND deleted_at IS NULL AND (folder = $2 OR folder LIKE $3))")
        .bind(user)
        .bind(folder)
        .bind(under(folder))
        .fetch_one(&st.pool)
        .await?)
}

/// A person's folder, when there is one: their linked note's, else where Pigeon's notes on them
/// are, else one the user already keeps under their full name.
pub async fn existing(st: &State, c: &Contact) -> anyhow::Result<Option<String>> {
    if let Some(note) = c.note_id {
        let f: Option<String> = sqlx::query_scalar("SELECT folder FROM notes WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL")
            .bind(note)
            .bind(&c.user_id)
            .fetch_optional(&st.pool)
            .await?;
        if let Some(f) = f.filter(|f| someones(f)) {
            return Ok(Some(f));
        }
    }
    // where Pigeon's notes on them are (the user may have moved them)
    let f: Option<String> = sqlx::query_scalar(
        "SELECT n.folder FROM db_pigeon_person_notes p JOIN notes n ON n.id = p.note_id AND n.deleted_at IS NULL
          WHERE p.contact_id = $1 AND n.folder <> '/' ORDER BY p.written_at DESC LIMIT 1",
    )
    .bind(c.id)
    .fetch_optional(&st.pool)
    .await?;
    if f.is_some() {
        return Ok(f);
    }
    // "/contacts/marta-rossi"
    if let Some(name) = c.name.as_deref() {
        for full in slugs::candidates(name).into_iter().filter(|s| s.contains('-')) {
            let f = format!("{ROOT}/{full}");
            if holds_notes(st, &c.user_id, &f).await? {
                return Ok(Some(f));
            }
        }
    }
    Ok(None)
}

/// A person's folder: the one there is, else one named after them (their slug), holding nothing
/// until a note is written there.
pub async fn of_person(st: &State, c: &Contact) -> anyhow::Result<String> {
    if let Some(f) = existing(st, c).await? {
        return Ok(f);
    }
    let name = match slugs::of(st, c.id).await? {
        Some(s) => s,
        None => format!("person-{}", &c.id.simple().to_string()[..8]),
    };
    Ok(format!("{ROOT}/{name}"))
}

/// A group chat's folder (it may hold nothing yet): named after the chat, "-group" when a person
/// has that name.
pub async fn of_chat(st: &State, conv: &Conversation) -> anyhow::Result<String> {
    let f: Option<String> = sqlx::query_scalar(
        "SELECT n.folder FROM db_pigeon_person_notes p JOIN notes n ON n.id = p.note_id AND n.deleted_at IS NULL
          WHERE p.conversation_id = $1 AND n.folder <> '/' ORDER BY p.written_at DESC LIMIT 1",
    )
    .bind(conv.id)
    .fetch_optional(&st.pool)
    .await?;
    if let Some(f) = f {
        return Ok(f);
    }
    let short = conv.id.simple().to_string();
    let mut name = conv.title.as_deref().map(name_of).filter(|n| !n.is_empty()).unwrap_or_else(|| format!("chat-{}", &short[..8]));
    let a_persons: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_contacts c LEFT JOIN notes n ON n.id = c.note_id
                         WHERE c.user_id = $1 AND (c.slug = $2 OR n.folder = $3))
             OR EXISTS (SELECT 1 FROM db_pigeon_person_notes p JOIN notes n ON n.id = p.note_id
                         WHERE p.user_id = $1 AND p.contact_id IS NOT NULL AND n.folder = $3)",
    )
    .bind(&conv.user_id)
    .bind(&name)
    .bind(format!("{ROOT}/{name}"))
    .fetch_one(&st.pool)
    .await?;
    if a_persons {
        name.push_str("-group");
    }
    // another chat of the same name has its own
    let another: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_person_notes p JOIN notes n ON n.id = p.note_id
                         WHERE p.user_id = $1 AND p.conversation_id IS NOT NULL AND p.conversation_id <> $2 AND n.folder = $3)",
    )
    .bind(&conv.user_id)
    .bind(conv.id)
    .bind(format!("{ROOT}/{name}"))
    .fetch_one(&st.pool)
    .await?;
    if another {
        name.push_str(&format!("-{}", &short[..4]));
    }
    Ok(format!("{ROOT}/{name}"))
}

/// The user's own notes in someone's folder (and the note linked to them, wherever it is), as
/// `(title, words)`: whole up to OWN_NOTES characters in all, the newest first past it. Pigeon's
/// own notes aren't among them. A folder that isn't someone's (not in `/contacts`) isn't read.
pub async fn own_notes(st: &State, user: &str, folder: &str, linked: Option<Uuid>) -> anyhow::Result<Vec<(String, String)>> {
    let notes: Vec<(String, String)> = sqlx::query_as(
        "SELECT n.title, n.content FROM notes n
          WHERE n.user_id = $1 AND n.deleted_at IS NULL AND length(trim(n.content)) > 0
            AND (($2 AND (n.folder = $3 OR n.folder LIKE $4)) OR n.id = $5)
            AND NOT EXISTS (SELECT 1 FROM db_pigeon_person_notes p WHERE p.note_id = n.id)
          ORDER BY n.updated_at DESC LIMIT $6",
    )
    .bind(user)
    .bind(someones(folder))
    .bind(folder)
    .bind(under(folder))
    .bind(linked)
    .bind(OWN_NOTES_MAX)
    .fetch_all(&st.pool)
    .await?;
    Ok(within(notes, OWN_NOTES))
}

/// Notes, newest first, within `cap` characters in all: the one that crosses it is cut there, the
/// older ones left out.
fn within(notes: Vec<(String, String)>, cap: usize) -> Vec<(String, String)> {
    let mut out = Vec::new();
    let mut left = cap;
    for (title, content) in notes {
        let text = content.trim();
        let n = text.chars().count();
        if n <= left {
            left -= n;
            out.push((title, text.to_string()));
            continue;
        }
        // a start too short to mean anything isn't worth its place
        if left >= 200 {
            out.push((title, format!("{}…", text.chars().take(left).collect::<String>())));
        }
        break;
    }
    out
}

/// What to write: a note of `whose`, its `kind` (and a style's channel), under `title` in `folder`
/// when it is new.
pub struct Note<'a> {
    pub user: &'a str,
    pub whose: Whose,
    pub kind: &'a str,
    pub connector: Option<&'a str>,
    pub title: &'a str,
    pub folder: &'a str,
    /// what it was written from (see `Kept::items`)
    pub items: i64,
    /// when it was written, when that isn't now (one copied from before)
    pub at: Option<DateTime<Utc>>,
}

/// Write one of Pigeon's notes: over `before` (the note as it was read), else a new one. None
/// when the note changed since it was read (the user is editing it): theirs stands, and is the
/// base of the next rewrite.
pub async fn write(st: &State, me: &Owner, note: &Note<'_>, text: &str, before: Option<&Kept>) -> anyhow::Result<Option<Uuid>> {
    let content = format!("{}\n\n{}\n", header(me, note.at), text.trim());
    let mut tx = st.pool.begin().await?;
    versions::set_change_source(&mut tx, "pigeon").await?;
    let id = match before {
        Some(b) => {
            let changed = sqlx::query("UPDATE notes SET content = $2 WHERE id = $1 AND content = $3 AND deleted_at IS NULL")
                .bind(b.note_id)
                .bind(&content)
                .bind(&b.content)
                .execute(&mut *tx)
                .await?
                .rows_affected();
            if changed == 0 {
                return Ok(None);
            }
            sqlx::query("UPDATE db_pigeon_person_notes SET written_hash = $2, written_at = NOW(), items = $3 WHERE note_id = $1")
                .bind(b.note_id)
                .bind(hash(&content))
                .bind(note.items as i32)
                .execute(&mut *tx)
                .await?;
            b.note_id
        }
        None => {
            let id: Uuid = sqlx::query_scalar("INSERT INTO notes (user_id, title, content, folder, tags) VALUES ($1, $2, $3, $4, $5) RETURNING id")
                .bind(note.user)
                .bind(note.title)
                .bind(&content)
                .bind(note.folder)
                .bind(vec![TAG.to_string()])
                .fetch_one(&mut *tx)
                .await?;
            // the row of a note since put in the trash gives way
            sqlx::query("DELETE FROM db_pigeon_person_notes WHERE COALESCE(contact_id, conversation_id) = $1 AND kind = $2 AND COALESCE(connector, '') = $3")
                .bind(note.whose.id())
                .bind(note.kind)
                .bind(note.connector.unwrap_or_default())
                .execute(&mut *tx)
                .await?;
            let (contact, chat) = match note.whose {
                Whose::Person(id) => (Some(id), None),
                Whose::Chat(id) => (None, Some(id)),
            };
            sqlx::query(
                "INSERT INTO db_pigeon_person_notes (user_id, contact_id, conversation_id, kind, connector, note_id, written_hash, items, written_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9, NOW()))",
            )
            .bind(note.user)
            .bind(contact)
            .bind(chat)
            .bind(note.kind)
            .bind(note.connector)
            .bind(id)
            .bind(hash(&content))
            .bind(note.items as i32)
            .bind(note.at)
            .execute(&mut *tx)
            .await?;
            id
        }
    };
    // embedded again, so it is found by a search (Piuma's too)
    sqlx::query("DELETE FROM embedding_jobs WHERE note_id = $1").bind(id).execute(&mut *tx).await?;
    sqlx::query("INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)").bind(id).bind(&content).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Some(id))
}

/// A style's title: "Pigeon · Style · WhatsApp" (a group chat's: "Pigeon · Style").
pub fn style_title(connector: Option<&str>) -> String {
    match connector {
        Some(c) => format!("Pigeon · Style · {}", channel(c)),
        None => "Pigeon · Style".to_string(),
    }
}

pub const MEMORY_TITLE: &str = "Pigeon · Memory";

/// A channel as it's written.
pub fn channel(connector: &str) -> String {
    match connector {
        "whatsapp" => "WhatsApp".to_string(),
        "gmail" => "Gmail".to_string(),
        "instagram" => "Instagram".to_string(),
        "telegram" => "Telegram".to_string(),
        c => {
            let mut s = c.to_string();
            if let Some(f) = s.get_mut(0..1) {
                f.make_ascii_uppercase();
            }
            s
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn contacts_and_what_is_in_it_are_private() {
        assert!(private("/contacts"));
        assert!(private("/contacts/"));
        assert!(private("/contacts/marta-rossi"));
        assert!(private("/contacts/marta-rossi/old"));
        assert!(!private("/contacts-old"));
        assert!(!private("/shared/house"));
        assert!(!private("/"));
        assert!(someones("/contacts/marta-rossi"));
        assert!(!someones("/contacts"));
        assert!(!someones("/contacts/"));
        assert!(!someones("/shared/contacts/x"));
    }

    #[test]
    fn the_line_at_the_top_and_the_spacing_dont_make_an_edit() {
        let written = "*Pigeon keeps this note · last written 2026-11-15 10:00*\n\n- A friend from school\n- Likes sailing\n";
        let h = hash(written);
        assert_eq!(body(written), "- A friend from school\n- Likes sailing");
        // the editor's own spacing, the line rewritten or gone
        assert_eq!(hash("_Pigeon keeps this note · last written 2026-11-15 10:00_\n\n\n- A friend from school\n\n- Likes sailing"), h);
        assert_eq!(hash("- A friend from school\n- Likes sailing\n"), h);
        // the user's words
        assert_ne!(hash("*Pigeon keeps this note · last written 2026-11-15 10:00*\n\n- A friend from school\n- Hates sailing\n"), h);
        assert_eq!(body("*Pigeon keeps this note*"), "");
    }

    #[test]
    fn a_group_chats_folder_is_named_after_it() {
        assert_eq!(name_of("Rossi Family 🏠"), "rossi-family");
        assert_eq!(name_of("  Calcetto (giovedì)  "), "calcetto-giovedì");
        assert_eq!(name_of("🏠🏠"), "");
        assert_eq!(under("/shared/50%_off"), "/shared/50\\%\\_off/%");
    }

    #[test]
    fn the_users_notes_are_read_whole_up_to_the_cap_newest_first() {
        let note = |t: &str, n: usize| (t.to_string(), "x".repeat(n));
        let read = within(vec![note("new", 300), note("mid", 500), note("old", 400)], 1000);
        assert_eq!(read.iter().map(|(t, c)| (t.as_str(), c.chars().count())).collect::<Vec<_>>(), vec![("new", 300), ("mid", 500), ("old", 201)]);
        // too little room left: the older one is left out
        let read = within(vec![note("new", 900), note("old", 400)], 1000);
        assert_eq!(read.len(), 1);
    }

    #[test]
    fn a_channel_as_its_written() {
        assert_eq!(style_title(Some("whatsapp")), "Pigeon · Style · WhatsApp");
        assert_eq!(style_title(Some("signal")), "Pigeon · Style · Signal");
        assert_eq!(style_title(None), "Pigeon · Style");
    }
}

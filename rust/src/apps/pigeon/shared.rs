//! The user's notes people may be told from (the Notes tool, `offer`): reading them, and only
//! them. A chat holds notes and folders (`access::Target`); a folder is every note in and under
//! it, the ones added later too.
//!
//!   - what is read is always inside what was given: the search below is the vault's own (words,
//!     meaning, the title's spelling, merged by rank) over those notes and no others
//!   - never a note in the trash, and never one of `/contacts`, whatever a grant says (a note
//!     moved there after it was shared, a folder renamed into it): what the user and Pigeon keep
//!     on people is not told
//!   - a card number (`card`) is never told on its own: a reply that holds one waits for the user
//!
//! Only the text: a note's attachments are neither read nor sent.

use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::embeddings;
use crate::apps::pigeon::access::Target;
use crate::apps::pigeon::folder;
use crate::apps::pigeon::state::State;

/// The words of a message that go into the search, at most.
const QUERY_WORDS: usize = 40;
/// What each way of searching brings, before they are merged.
const POOL: i64 = 30;

#[derive(Debug, Clone, FromRow)]
pub struct Note {
    pub id: Uuid,
    pub title: String,
    pub content: String,
    pub folder: String,
}

const COLS: &str = "n.id, n.title, n.content, COALESCE(n.folder, '/') AS folder";
/// A note that may be read at all: not in the trash, not of `/contacts`.
const READABLE: &str = "n.deleted_at IS NULL AND COALESCE(n.folder, '/') <> '/contacts' AND COALESCE(n.folder, '/') NOT LIKE '/contacts/%'";
/// Inside what was given: `$2` the notes, `$3` the folders, `$4` what is under them.
const GIVEN: &str = "(n.id = ANY($2) OR n.folder = ANY($3) OR n.folder LIKE ANY($4))";

/// Whether a target is this note, or a folder it is in or under.
pub fn covers(t: &Target, n: &Note) -> bool {
    match t {
        Target::Note(id) => *id == n.id,
        Target::Folder(f) => n.folder == *f || n.folder.starts_with(&format!("{f}/")),
    }
}

fn parts(targets: &[Target]) -> (Vec<Uuid>, Vec<String>, Vec<String>) {
    let (mut ids, mut folders, mut under) = (Vec::new(), Vec::new(), Vec::new());
    for t in targets {
        match t {
            Target::Note(id) => ids.push(*id),
            Target::Folder(f) => {
                folders.push(f.clone());
                under.push(folder::under(f));
            }
        }
    }
    (ids, folders, under)
}

/// A message as the words search takes it: any of its words, by their start ("passw" finds
/// "password"). None: no word in it.
fn any_word(query: &str) -> Option<String> {
    let mut words: Vec<String> = Vec::new();
    for w in query.split(|c: char| !c.is_alphanumeric()).filter(|w| w.chars().count() >= 3).map(str::to_lowercase) {
        if !words.contains(&w) {
            words.push(w);
        }
    }
    words.truncate(QUERY_WORDS);
    (!words.is_empty()).then(|| words.iter().map(|w| format!("{w}:*")).collect::<Vec<_>>().join(" | "))
}

/// One of the user's notes, when it may be read.
pub async fn read(st: &State, user: &str, id: Uuid) -> anyhow::Result<Option<Note>> {
    Ok(sqlx::query_as(&format!("SELECT {COLS} FROM notes n WHERE n.id = $1 AND n.user_id = $2 AND {READABLE}")).bind(id).bind(user).fetch_optional(&st.pool).await?)
}

/// Of the notes given (`targets`), the ones nearest to what was asked, best first. With few
/// enough given, all of them: the choice among them is Jev's.
pub async fn search(st: &State, user: &str, targets: &[Target], query: &str, limit: i64) -> anyhow::Result<Vec<Note>> {
    if targets.is_empty() {
        return Ok(Vec::new());
    }
    let (ids, folders, under) = parts(targets);
    let n: i64 = sqlx::query_scalar(&format!("SELECT COUNT(*) FROM notes n WHERE n.user_id = $1 AND {GIVEN} AND {READABLE}"))
        .bind(user)
        .bind(&ids)
        .bind(&folders)
        .bind(&under)
        .fetch_one(&st.pool)
        .await?;
    if n == 0 {
        return Ok(Vec::new());
    }
    if n <= limit {
        return Ok(sqlx::query_as(&format!("SELECT {COLS} FROM notes n WHERE n.user_id = $1 AND {GIVEN} AND {READABLE} ORDER BY n.updated_at DESC"))
            .bind(user)
            .bind(&ids)
            .bind(&folders)
            .bind(&under)
            .fetch_all(&st.pool)
            .await?);
    }
    // the meaning, when the query can be embedded (else words and titles only)
    let vector = match embeddings::embed(&st.pool, query, 1536, "embedding:search").await {
        Ok(v) => Some(format!("[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))),
        Err(e) => {
            log::warn!("pigeon notes: the search goes by words only: {e}");
            None
        }
    };
    let words = any_word(query);
    let sql = format!(
        "WITH given AS (SELECT n.id, n.title, n.content_tsv, n.embedding FROM notes n WHERE n.user_id = $1 AND {GIVEN} AND {READABLE}),
              fts AS (SELECT id, ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsv, to_tsquery('english', $5)) DESC) AS rn
                        FROM given WHERE $5::text IS NOT NULL AND content_tsv @@ to_tsquery('english', $5) ORDER BY rn LIMIT $8),
              vec AS (SELECT id, ROW_NUMBER() OVER (ORDER BY embedding <=> $6::vector) AS rn
                        FROM given WHERE $6::text IS NOT NULL AND embedding IS NOT NULL ORDER BY rn LIMIT $8),
              tri AS (SELECT id, ROW_NUMBER() OVER (ORDER BY word_similarity(title, $7) DESC) AS rn
                        FROM given WHERE word_similarity(title, $7) > 0.4 ORDER BY rn LIMIT $8),
              ranked AS (SELECT id, SUM(1.0 / (60 + rn)) AS score FROM (SELECT * FROM fts UNION ALL SELECT * FROM vec UNION ALL SELECT * FROM tri) pools GROUP BY id)
         SELECT {COLS} FROM ranked r JOIN notes n ON n.id = r.id ORDER BY r.score DESC, n.updated_at DESC LIMIT $9"
    );
    Ok(sqlx::query_as(&sql)
        .bind(user)
        .bind(&ids)
        .bind(&folders)
        .bind(&under)
        .bind(&words)
        .bind(&vector)
        .bind(query.chars().take(400).collect::<String>())
        .bind(POOL)
        .bind(limit)
        .fetch_all(&st.pool)
        .await?)
}

// ── a card number: never told on its own ─────────────────────────────────

/// A card number's check (Luhn): from the right, every second digit doubled.
fn luhn(digits: &[u32]) -> bool {
    let sum: u32 = digits
        .iter()
        .rev()
        .enumerate()
        .map(|(i, d)| match (i % 2, d * 2) {
            (0, _) => *d,
            (_, twice) if twice > 9 => twice - 9,
            (_, twice) => twice,
        })
        .sum();
    sum % 10 == 0
}

/// Whether a text holds what reads as a card number: 13 to 19 digits, in a run or in groups,
/// that pass Luhn. An account number or an IBAN is not one: those are given to be paid.
pub fn card(text: &str) -> bool {
    let chars: Vec<char> = text.chars().collect();
    let sep = |c: char| c == ' ' || c == '-' || c == '\u{a0}';
    for i in 0..chars.len() {
        if !chars[i].is_ascii_digit() || (i > 0 && chars[i - 1].is_ascii_alphanumeric()) {
            continue;
        }
        let mut digits: Vec<u32> = Vec::new();
        let mut j = i;
        while j < chars.len() && digits.len() <= 19 {
            match chars[j] {
                c if c.is_ascii_digit() => digits.extend(c.to_digit(10)),
                c if sep(c) && j + 1 < chars.len() && chars[j + 1].is_ascii_digit() => {}
                _ => break,
            }
            j += 1;
        }
        if (13..=19).contains(&digits.len()) && luhn(&digits) {
            return true;
        }
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn note(folder: &str) -> Note {
        Note { id: Uuid::from_u128(7), title: "Wifi".into(), content: "the code".into(), folder: folder.into() }
    }

    #[test]
    fn a_folder_covers_what_is_in_and_under_it() {
        let shared = Target::Folder("/shared/trip".into());
        assert!(covers(&shared, &note("/shared/trip")));
        assert!(covers(&shared, &note("/shared/trip/day-1")));
        assert!(!covers(&shared, &note("/shared/trips")));
        assert!(!covers(&shared, &note("/shared")));
        assert!(covers(&Target::Note(Uuid::from_u128(7)), &note("/anywhere")));
        assert!(!covers(&Target::Note(Uuid::from_u128(8)), &note("/anywhere")));
    }

    #[test]
    fn a_message_is_searched_by_any_of_its_words() {
        assert_eq!(any_word("What's the wifi password? The WIFI one").unwrap(), "what:* | the:* | wifi:* | password:* | one:*");
        assert!(any_word("?? ok").is_none());
        // nothing in it can break the query
        assert_eq!(any_word("a' | !b & (door:code)").unwrap(), "door:* | code:*");
    }

    #[test]
    fn a_card_number_is_found_by_its_check() {
        // a made-up number that passes its check (the standard example)
        assert!(card("card 4111 1111 1111 1111 exp 12/30"));
        assert!(card("4111-1111-1111-1111"));
        assert!(card("il numero è 4111111111111111."));
        // one digit off: not a card
        assert!(!card("4111 1111 1111 1112"));
        // what is given to be paid, and what a note usually holds
        assert!(!card("Send it to GB82 WEST 1234 5698 7654 32, thanks"));
        assert!(!card("iban: DE89370400440532013000"));
        assert!(!card("l'account è 1463318227"));
        assert!(!card("Door code 4821, wifi Casa-5G, password limone2024"));
        assert!(!card("Call me on +39 333 1234567 after 18:00, flight AZ1234 on 2026-12-01"));
    }
}

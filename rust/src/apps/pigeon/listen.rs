//! Voice notes heard: a voice message or an audio file that came in is transcribed (Speechmatics'
//! batch API, the key of admin → Services) once it's in storage (`soon`, from `media`), its words
//! kept on its entry in the message's `media`:
//!
//!   transcript         the words
//!   transcript_lang    the language they were heard in (ISO)
//!   transcript_status  listening, done, failed (given up), skipped (too old or too long to hear)
//!
//! Pigeon reads them in place of "[voice message]" (`conversations::said`), and a triage waits
//! for them a little (`wait`). A long clip's language is detected; a short one's can't be (a few
//! seconds sound like anything), so it's heard in the chat's language: one heard there before, or
//! the one its messages are written in, or the user's own.

use std::sync::LazyLock;
use std::time::Duration;

use chrono::{DateTime, Utc};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::media;
use crate::apps::pigeon::state::{self, State};
use crate::apps::transcription::providers::speechmatics::{self, Unheard};
use crate::db::db::DbPool;

/// How many are heard at once.
static HEARING: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(2));
/// A clip at least this long has its language detected.
const DETECT_SECS: i64 = 10;
/// Longer clips aren't heard.
const MAX_SECS: i64 = 15 * 60;
/// Messages older than this when their file is stored (history) aren't heard.
const FRESH_HOURS: i64 = 24;
/// How long one transcription may take.
const JOB_SECS: u64 = 180;
/// Tries before one is given up.
const TRIES: i64 = 3;
/// How long a triage waits for a new voice note's words, from when it came in.
const WAIT_SECS: i64 = 90;
/// One still `listening` this long was cut off (a restart): heard again.
const STALE_MINUTES: i64 = 5;

/// A file that has words to hear: a voice message, an audio file.
pub fn hearable(m: &Json) -> bool {
    matches!(m["kind"].as_str(), Some("voice" | "audio"))
}

/// Its words are settled: heard, given up, or never to be heard.
fn settled(m: &Json) -> bool {
    matches!(m["transcript_status"].as_str(), Some("done" | "failed" | "skipped"))
}

/// A triage should wait for it: hearable, its file on the way or stored, its words not in yet.
fn awaited(m: &Json) -> bool {
    hearable(m) && matches!(m["status"].as_str(), Some("pending" | "stored")) && !settled(m)
}

/// The stored voice notes of a message: heard now, in the background.
pub fn soon(pool: &DbPool, item: Uuid) {
    let st = state::shared(pool);
    tokio::spawn(async move {
        if let Err(e) = hear(&st, item).await {
            log::warn!("pigeon listen {item}: {e:#}");
        }
    });
}

/// Voice notes stored but not heard (a failed try, a restart): heard again, by the worker's sweep.
pub async fn retry(st: &State) -> anyhow::Result<usize> {
    let rows: Vec<(Uuid, Json)> = sqlx::query_as(
        "SELECT id, media FROM db_pigeon_items
          WHERE (media @> '[{\"kind\": \"voice\", \"status\": \"stored\"}]'::jsonb OR media @> '[{\"kind\": \"audio\", \"status\": \"stored\"}]'::jsonb)
            AND created_at > NOW() - make_interval(hours => $1::int) AND created_at < NOW() - INTERVAL '2 minutes'
          ORDER BY created_at DESC LIMIT 50",
    )
    .bind(FRESH_HOURS as i32)
    .fetch_all(&st.pool)
    .await?;
    let mut n = 0;
    for (item, media) in rows {
        if media.as_array().into_iter().flatten().any(|m| due(m, Utc::now())) {
            hear(st, item).await?;
            n += 1;
        }
    }
    Ok(n)
}

/// To hear now: stored, not settled, and not being heard (or cut off while it was).
fn due(m: &Json, now: DateTime<Utc>) -> bool {
    if !hearable(m) || m["status"] != "stored" || settled(m) {
        return false;
    }
    let since = m["transcript_at"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok());
    m["transcript_status"] != "listening" || since.is_none_or(|t| now - t.with_timezone(&Utc) > chrono::Duration::minutes(STALE_MINUTES))
}

/// Hear a message's stored voice notes, each entry updated as it goes; the chat shows the words.
async fn hear(st: &State, item: Uuid) -> anyhow::Result<()> {
    let row: Option<(String, Uuid, Json, DateTime<Utc>)> = sqlx::query_as(
        "SELECT c.user_id, c.id, i.media, i.created_at FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id WHERE i.id = $1",
    )
    .bind(item)
    .fetch_optional(&st.pool)
    .await?;
    let Some((user, conversation, media, created)) = row else { return Ok(()) };
    let now = Utc::now();
    let mut changed = false;
    for m in media.as_array().into_iter().flatten().filter(|m| due(m, now)) {
        let Some(id) = m["id"].as_str() else { continue };
        let seconds = m["seconds"].as_i64();
        if now - created > chrono::Duration::hours(FRESH_HOURS) || seconds.is_some_and(|s| s > MAX_SECS) {
            media::update(&st.pool, item, id, &json!({ "transcript_status": "skipped" })).await?;
            continue;
        }
        let Ok(key) = crate::apps::transcription::key_for(&st.pool, "speechmatics").await else {
            media::update(&st.pool, item, id, &json!({ "transcript_status": "skipped", "transcript_error": "no Speechmatics key (admin → Services)" })).await?;
            continue;
        };
        let _turn = HEARING.acquire().await?;
        media::update(&st.pool, item, id, &json!({ "transcript_status": "listening", "transcript_at": Utc::now().to_rfc3339() })).await?;
        let patch = match listen(st, &key, conversation, &user, m, seconds).await {
            Ok(h) => json!({ "transcript": h.text, "transcript_lang": h.language, "transcript_status": "done", "transcript_error": null }),
            Err(why) => {
                let tries = m["transcript_tries"].as_i64().unwrap_or(0) + 1;
                log::info!("pigeon listen {id} of {item}: try {tries}: {why}");
                // back to not heard (the sweep tries again), or given up
                let status = if tries >= TRIES { json!("failed") } else { Json::Null };
                json!({ "transcript_status": status, "transcript_tries": tries, "transcript_error": why })
            }
        };
        media::update(&st.pool, item, id, &patch).await?;
        changed = true;
    }
    if changed {
        crate::apps::pigeon::events::publish(&st.pool, &user, "conversation", Some(conversation)).await;
    }
    Ok(())
}

/// One voice note's words: a long one in the language detected (the chat's when it can't tell),
/// a short one in the chat's.
async fn listen(st: &State, key: &str, conversation: Uuid, user: &str, m: &Json, seconds: Option<i64>) -> Result<speechmatics::Heard, String> {
    let file_key = m["key"].as_str().ok_or("no file")?;
    let mime = m["mime"].as_str().unwrap_or("audio/ogg");
    let bytes = media::bytes(&st.pool, file_key).await.map_err(|e| format!("{e:#}"))?;
    let wait = Duration::from_secs(JOB_SECS);
    let detect = seconds.is_none_or(|s| s >= DETECT_SECS);
    if detect {
        match speechmatics::transcribe_file(key, bytes.clone(), mime, None, wait).await {
            Ok(h) => return Ok(h),
            Err(Unheard::Failed(why)) => return Err(why),
            Err(Unheard::Rejected(why)) => log::info!("pigeon listen: no language detected ({why}): the chat's"),
        }
    }
    let lang = chat_language(&st.pool, conversation, user).await;
    match speechmatics::transcribe_file(key, bytes, mime, Some(&lang), wait).await {
        Ok(h) => Ok(h),
        Err(Unheard::Failed(why) | Unheard::Rejected(why)) => Err(why),
    }
}

/// The language a chat is in: one of its voice notes was heard in, else the one its messages are
/// written in, else the user's own (their messages anywhere), else English.
async fn chat_language(pool: &DbPool, conversation: Uuid, user: &str) -> String {
    let heard: Option<String> = sqlx::query_scalar(
        "SELECT e->>'transcript_lang' FROM db_pigeon_items i, jsonb_array_elements(i.media) e
          WHERE i.conversation_id = $1 AND jsonb_typeof(e) = 'object' AND e->>'transcript_status' = 'done'
            AND COALESCE((e->>'seconds')::int, 0) >= $2
          ORDER BY i.at DESC LIMIT 1",
    )
    .bind(conversation)
    .bind(DETECT_SECS as i32)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten();
    if let Some(l) = heard {
        return l;
    }
    let here: Vec<String> = sqlx::query_scalar("SELECT body FROM db_pigeon_items WHERE conversation_id = $1 ORDER BY at DESC LIMIT 40")
        .bind(conversation)
        .fetch_all(pool)
        .await
        .unwrap_or_default();
    if let Some(l) = guess_language(&here) {
        return l.into();
    }
    let mine: Vec<String> = sqlx::query_scalar(
        "SELECT i.body FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.user_id = $1 AND i.author = 'me' AND c.connector <> 'gmail' ORDER BY i.at DESC LIMIT 100",
    )
    .bind(user)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    guess_language(&mine).unwrap_or("en").into()
}

/// The language most of these texts are in, by their common words (a script for Thai), when it's
/// clear: an ISO code.
fn guess_language(texts: &[String]) -> Option<&'static str> {
    const WORDS: [(&str, &[&str]); 6] = [
        ("it", &["che", "non", "il", "sono", "per", "ma", "ho", "è", "mi", "ti", "ci", "una", "anche", "cosa", "perché", "sei", "bene", "ciao", "grazie", "questo", "poi", "io", "tu", "domani", "oggi", "allora", "dai"]),
        ("en", &["the", "and", "you", "is", "to", "it", "that", "what", "are", "for", "have", "not", "this", "my", "i'm", "we", "so", "just", "can", "will", "thanks", "hello", "today", "tomorrow"]),
        ("es", &["que", "el", "los", "las", "es", "pero", "con", "para", "muy", "está", "yo", "qué", "como", "gracias", "hola", "mañana", "hoy"]),
        ("fr", &["le", "les", "des", "est", "pas", "je", "vous", "et", "pour", "avec", "c'est", "mais", "bien", "merci", "bonjour", "aujourd'hui", "demain"]),
        ("de", &["und", "der", "die", "das", "ist", "nicht", "ich", "du", "ein", "eine", "mit", "auch", "danke", "hallo", "was", "wie", "heute", "morgen"]),
        ("pt", &["não", "você", "com", "mas", "obrigado", "obrigada", "olá", "tudo", "muito", "isso", "hoje", "amanhã"]),
    ];
    let text = texts.join(" ").to_lowercase();
    let thai = text.chars().filter(|c| ('\u{0E00}'..='\u{0E7F}').contains(c)).count();
    let letters = text.chars().filter(|c| c.is_alphabetic()).count();
    if letters > 0 && thai * 2 > letters {
        return Some("th");
    }
    let words: Vec<&str> = text.split(|c: char| !(c.is_alphabetic() || c == '\'')).filter(|w| !w.is_empty()).collect();
    let mut scores: Vec<(&str, usize)> = WORDS.iter().map(|(l, list)| (*l, words.iter().filter(|w| list.contains(w)).count())).collect();
    scores.sort_by(|a, b| b.1.cmp(&a.1));
    let (best, n) = scores[0];
    (n >= 3 && n > scores[1].1 * 3 / 2).then_some(best)
}

/// A triage about to read the conversation waits for the words of a voice note that came in
/// just now (`WAIT_SECS` at most from its arrival); the chat shows Pigeon listening.
pub async fn wait(st: &State, conversation: Uuid) -> anyhow::Result<()> {
    let mut shown = false;
    loop {
        let rows: Vec<(DateTime<Utc>, Json)> = sqlx::query_as(
            "SELECT created_at, media FROM db_pigeon_items WHERE conversation_id = $1 AND direction = 'in' AND created_at > NOW() - make_interval(secs => $2::int)",
        )
        .bind(conversation)
        .bind(WAIT_SECS as i32)
        .fetch_all(&st.pool)
        .await?;
        let until = rows
            .iter()
            .filter(|(_, media)| media.as_array().into_iter().flatten().any(awaited))
            .map(|(at, _)| *at + chrono::Duration::seconds(WAIT_SECS))
            .max();
        let Some(until) = until else { return Ok(()) };
        if !shown {
            crate::apps::pigeon::events::working(&st.pool, conversation, "listening", Some(until), None).await;
            shown = true;
        }
        tokio::time::sleep(Duration::from_secs(2)).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn languages_by_their_words() {
        assert_eq!(guess_language(&s(&["Domani lavori o giraffa?", "Porcoddioo foto!", "ma che è sto robo? non ci credo"])), Some("it"));
        assert_eq!(guess_language(&s(&["what are you doing tomorrow?", "I'm at the beach, it is so hot"])), Some("en"));
        assert_eq!(guess_language(&s(&["สวัสดีครับ วันนี้ไปไหน"])), Some("th"));
        assert_eq!(guess_language(&s(&["ok", "👍"])), None, "too little to tell");
    }

    #[test]
    fn what_is_heard_and_waited_for() {
        let now = Utc::now();
        let voice = |extra: Json| {
            let mut m = json!({ "kind": "voice", "status": "stored" });
            m.as_object_mut().unwrap().extend(extra.as_object().unwrap().clone());
            m
        };
        assert!(due(&voice(json!({})), now));
        assert!(!due(&json!({ "kind": "image", "status": "stored" }), now), "not audio");
        assert!(!due(&voice(json!({ "transcript_status": "done" })), now));
        assert!(!due(&voice(json!({ "transcript_status": "listening", "transcript_at": now.to_rfc3339() })), now), "being heard");
        let cut = (now - chrono::Duration::minutes(STALE_MINUTES + 1)).to_rfc3339();
        assert!(due(&voice(json!({ "transcript_status": "listening", "transcript_at": cut })), now), "cut off");
        assert!(awaited(&json!({ "kind": "voice", "status": "pending" })), "its file still on the way");
        assert!(!awaited(&json!({ "kind": "voice", "status": "gone" })));
        assert!(!awaited(&voice(json!({ "transcript_status": "failed" }))));
    }
}

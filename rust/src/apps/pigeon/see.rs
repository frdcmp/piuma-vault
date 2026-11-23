//! Images seen: a photo or a sticker in a chat (in or out, not Gmail's: a mail's pictures are
//! mostly logos) is looked at by a model that sees images (`llm::look`: the one picked for
//! Pigeon's eyes, else Pigeon's own when it can) once it's in storage, what it shows kept on its
//! entry in the message's `media`:
//!
//!   seen         what it shows, in a few sentences, and the words written in it
//!   seen_status  looking, done, failed (given up), skipped (too old, too big, no model that sees)
//!
//! Pigeon reads it in place of "[image]" (`conversations::said`). A triage looks at the new
//! images of its chat first (`wait`: it waits a little for one still on its way, the way it waits
//! for a voice note's words in `listen`); the worker's sweep looks at the rest (`retry`: a failed
//! try, a restart, a chat with no triage, what the user sent). Both on the worker's own thread:
//! a model call can't go to another.

use std::io::Cursor;
use std::sync::LazyLock;
use std::time::Duration;

use base64::Engine;
use chrono::{DateTime, Utc};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::ai::llm;
use crate::apps::pigeon::media;
use crate::apps::pigeon::state::State;

/// How many are looked at at once.
static LOOKING: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(2));
/// Messages older than this when their file is stored (history) aren't looked at.
const FRESH_HOURS: i64 = 24;
/// Larger files aren't looked at.
const MAX_BYTES: i64 = 20 << 20;
/// What the model is given: the image at most this many pixels a side.
const SIDE: u32 = 1280;
/// Tries before one is given up.
const TRIES: i64 = 3;
/// How long a triage waits for a new image's description, from when it came in.
const WAIT_SECS: i64 = 45;
/// One still `looking` this long was cut off (a restart): looked at again.
const STALE_MINUTES: i64 = 5;
/// The most of a description Pigeon keeps.
const SEEN_CHARS: usize = 700;
/// The most messages one sweep looks at (the other sweeps wait for it).
const SWEEP_ITEMS: usize = 8;
/// The most images of one message looked at (an album).
const PER_MESSAGE: usize = 6;

const PROMPT: &str = "Someone's chat has an image in it, and an assistant who can't see it has to understand it and \
answer the chat. Describe it for them in English, in one to three short sentences: what kind of image it is (a photo, \
a selfie, a screenshot of a chat or an app, a meme, a document, a sticker), what it shows that matters to someone \
replying, and the mood if it's a meme or a sticker. Copy any words written in it as they are, in their language (the \
main ones, a few lines at most). Never say who a person is from their face: \"a man\", \"two women\". No preamble, \
nothing about yourself.";

/// A file to look at: a photo, a sticker.
pub fn seeable(m: &Json) -> bool {
    matches!(m["kind"].as_str(), Some("image" | "sticker"))
}

/// Its description is settled: seen, given up, or never to be seen.
fn settled(m: &Json) -> bool {
    matches!(m["seen_status"].as_str(), Some("done" | "failed" | "skipped"))
}

/// A triage should wait for it: seeable, its file on the way or stored, not described yet.
fn awaited(m: &Json) -> bool {
    seeable(m) && matches!(m["status"].as_str(), Some("pending" | "stored")) && !settled(m)
}

/// Images stored but not looked at (a failed try, a restart, a chat with no triage, one the user
/// sent): looked at by the worker's sweep, a few a turn.
pub async fn retry(st: &State) -> anyhow::Result<usize> {
    let rows: Vec<(Uuid, Json)> = sqlx::query_as(
        "SELECT i.id, i.media FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE (i.media @> '[{\"kind\": \"image\", \"status\": \"stored\"}]'::jsonb OR i.media @> '[{\"kind\": \"sticker\", \"status\": \"stored\"}]'::jsonb)
            AND c.connector <> 'gmail'
            AND i.created_at > NOW() - make_interval(hours => $1::int) AND i.created_at < NOW() - INTERVAL '1 minute'
          ORDER BY i.created_at DESC LIMIT 30",
    )
    .bind(FRESH_HOURS as i32)
    .fetch_all(&st.pool)
    .await?;
    let mut n = 0;
    for (item, media) in rows {
        if n < SWEEP_ITEMS && media.as_array().into_iter().flatten().any(|m| due(m, Utc::now())) {
            look(st, item).await?;
            n += 1;
        }
    }
    Ok(n)
}

/// To look at now: stored, not settled, and not being looked at (or cut off while it was).
fn due(m: &Json, now: DateTime<Utc>) -> bool {
    if !seeable(m) || m["status"] != "stored" || settled(m) {
        return false;
    }
    let since = m["seen_at"].as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok());
    m["seen_status"] != "looking" || since.is_none_or(|t| now - t.with_timezone(&Utc) > chrono::Duration::minutes(STALE_MINUTES))
}

/// Look at a message's stored images, each entry updated as it goes; the chat shows what's seen.
async fn look(st: &State, item: Uuid) -> anyhow::Result<()> {
    let row: Option<(String, Uuid, String, Json, DateTime<Utc>, String)> = sqlx::query_as(
        "SELECT c.user_id, c.id, c.connector, i.media, i.created_at, i.body FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id WHERE i.id = $1",
    )
    .bind(item)
    .fetch_optional(&st.pool)
    .await?;
    let Some((user, conversation, connector, media, created, body)) = row else { return Ok(()) };
    if connector == "gmail" {
        return Ok(());
    }
    let now = Utc::now();
    let caption = media::words(&body, &media);
    let mut changed = false;
    for (n, m) in media.as_array().into_iter().flatten().filter(|m| seeable(m)).enumerate() {
        if !due(m, now) {
            continue;
        }
        let Some(id) = m["id"].as_str() else { continue };
        if n >= PER_MESSAGE || now - created > chrono::Duration::hours(FRESH_HOURS) || m["size"].as_i64().is_some_and(|s| s > MAX_BYTES) {
            media::update(&st.pool, item, id, &json!({ "seen_status": "skipped" })).await?;
            continue;
        }
        if !llm::can_see(&st.pool).await {
            media::update(&st.pool, item, id, &json!({ "seen_status": "skipped", "seen_error": "no model that sees images (Inbox settings → Pigeon's brain)" })).await?;
            continue;
        }
        let _turn = LOOKING.acquire().await?;
        media::update(&st.pool, item, id, &json!({ "seen_status": "looking", "seen_at": Utc::now().to_rfc3339() })).await?;
        let patch = match describe(st, &connector, &caption, m).await {
            Ok(seen) => json!({ "seen": seen, "seen_status": "done", "seen_error": null }),
            Err(why) => {
                let tries = m["seen_tries"].as_i64().unwrap_or(0) + 1;
                log::info!("pigeon see {id} of {item}: try {tries}: {why}");
                // back to not seen (the sweep tries again), or given up
                let status = if tries >= TRIES { json!("failed") } else { Json::Null };
                json!({ "seen_status": status, "seen_tries": tries, "seen_error": why })
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

/// What one image shows, in the model's words.
async fn describe(st: &State, connector: &str, caption: &str, m: &Json) -> Result<String, String> {
    let key = m["key"].as_str().ok_or("no file")?;
    let bytes = media::bytes(&st.pool, key).await.map_err(|e| format!("{e:#}"))?;
    let mime = m["mime"].as_str().unwrap_or("image/jpeg").to_string();
    let (bytes, mime) = tokio::task::spawn_blocking(move || fit(bytes, &mime)).await.map_err(|e| e.to_string())??;
    let url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
    let kind = m["kind"].as_str().unwrap_or("image");
    let a = if kind == "image" { "An" } else { "A" };
    let about = if caption.is_empty() { format!("{a} {kind} sent on {connector}.") } else { format!("{a} {kind} sent on {connector}, with the words: {caption}") };
    let seen = llm::look(&st.pool, PROMPT, &about, &url).await.map_err(|e| format!("{e:#}"))?;
    let seen = crate::apps::pigeon::conversations::clip(&seen, SEEN_CHARS);
    if seen.is_empty() {
        return Err("the model said nothing".into());
    }
    Ok(seen)
}

/// The image as the model is given it: at most `SIDE` a side, a JPEG (a PNG with see-through
/// parts stays a PNG); one that can't be read goes as it came, if a model can take it.
fn fit(bytes: Vec<u8>, mime: &str) -> Result<(Vec<u8>, String), String> {
    let img = match image::load_from_memory(&bytes) {
        Ok(i) => i,
        Err(e) => {
            return match mime {
                "image/jpeg" | "image/png" | "image/webp" | "image/gif" => Ok((bytes, mime.to_string())),
                _ => Err(format!("can't read it ({mime}): {e}")),
            };
        }
    };
    let img = if img.width() > SIDE || img.height() > SIDE { img.resize(SIDE, SIDE, image::imageops::FilterType::Triangle) } else { img };
    let mut out = Cursor::new(Vec::new());
    if img.color().has_alpha() {
        img.write_to(&mut out, image::ImageFormat::Png).map_err(|e| e.to_string())?;
        Ok((out.into_inner(), "image/png".into()))
    } else {
        image::codecs::jpeg::JpegEncoder::new_with_quality(&mut out, 85).encode_image(&img.to_rgb8()).map_err(|e| e.to_string())?;
        Ok((out.into_inner(), "image/jpeg".into()))
    }
}

/// A triage about to read the conversation looks at the images that came in just now, and waits
/// for one still on its way (`WAIT_SECS` at most from its arrival); the chat shows Pigeon looking.
pub async fn wait(st: &State, conversation: Uuid) -> anyhow::Result<()> {
    let mut shown = false;
    loop {
        let rows: Vec<(Uuid, DateTime<Utc>, Json)> = sqlx::query_as(
            "SELECT i.id, i.created_at, i.media FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
              WHERE i.conversation_id = $1 AND i.direction = 'in' AND c.connector <> 'gmail' AND i.created_at > NOW() - make_interval(secs => $2::int)",
        )
        .bind(conversation)
        .bind(WAIT_SECS as i32)
        .fetch_all(&st.pool)
        .await?;
        let waiting: Vec<&(Uuid, DateTime<Utc>, Json)> = rows.iter().filter(|(_, _, media)| media.as_array().into_iter().flatten().any(awaited)).collect();
        let Some(until) = waiting.iter().map(|(_, at, _)| *at + chrono::Duration::seconds(WAIT_SECS)).max() else { return Ok(()) };
        if !shown {
            crate::apps::pigeon::events::working(&st.pool, conversation, "looking", Some(until), None).await;
            shown = true;
        }
        let now = Utc::now();
        let ready: Vec<Uuid> = waiting.iter().filter(|(_, _, media)| media.as_array().into_iter().flatten().any(|m| due(m, now))).map(|(id, _, _)| *id).collect();
        for item in &ready {
            look(st, *item).await?;
        }
        if ready.is_empty() {
            tokio::time::sleep(Duration::from_secs(2)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn what_is_looked_at_and_waited_for() {
        let now = Utc::now();
        let photo = json!({ "kind": "image", "status": "stored" });
        assert!(due(&photo, now) && awaited(&photo));
        assert!(!due(&json!({ "kind": "voice", "status": "stored" }), now), "a voice note is heard, not seen");
        assert!(!due(&json!({ "kind": "image", "status": "pending" }), now), "not in storage yet");
        assert!(awaited(&json!({ "kind": "sticker", "status": "pending" })), "on its way: waited for");
        assert!(!due(&json!({ "kind": "image", "status": "stored", "seen_status": "done" }), now));
        let looking = json!({ "kind": "image", "status": "stored", "seen_status": "looking", "seen_at": now.to_rfc3339() });
        assert!(!due(&looking, now), "being looked at");
        assert!(due(&looking, now + chrono::Duration::minutes(STALE_MINUTES + 1)), "cut off: again");
    }

    /// By hand, against a dev database's model: `SEE_IMAGE=photo.jpg DATABASE_URL=… cargo test
    /// --lib see::tests::a_real_photo -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn a_real_photo() {
        let pool = crate::db::db::create_pool().await.unwrap();
        let bytes = std::fs::read(std::env::var("SEE_IMAGE").unwrap()).unwrap();
        let (bytes, mime) = fit(bytes, "image/jpeg").unwrap();
        let url = format!("data:{mime};base64,{}", base64::engine::general_purpose::STANDARD.encode(&bytes));
        assert!(llm::can_see(&pool).await, "no model that sees");
        println!("{}", llm::look(&pool, PROMPT, "An image sent on whatsapp.", &url).await.unwrap());
    }

    #[test]
    fn a_big_photo_is_made_smaller() {
        let big = image::DynamicImage::new_rgb8(3000, 1500);
        let mut png = Cursor::new(Vec::new());
        big.write_to(&mut png, image::ImageFormat::Png).unwrap();
        let (out, mime) = fit(png.into_inner(), "image/png").unwrap();
        assert_eq!(mime, "image/jpeg");
        let back = image::load_from_memory(&out).unwrap();
        assert_eq!((back.width(), back.height()), (SIDE, SIDE / 2));
        assert!(fit(b"not an image".to_vec(), "image/heic").is_err());
    }
}

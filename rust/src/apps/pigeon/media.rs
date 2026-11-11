//! Media: the photos, videos, voice notes and files that come with messages, kept in the vault's
//! storage (S3), each under its own UUID:
//!
//!   pigeon/<user>/media/<channel>/<yyyy>/<mm>/<uuid>.<ext>     the file
//!   pigeon/<user>/media/<channel>/<yyyy>/<mm>/<uuid>.thumb.jpg  its preview (WhatsApp's)
//!
//! A message's `media` lists them: `{id, kind, label, mime, name, size, seconds, width, height,
//! key, thumb, status}` each (`status`: pending, stored, gone (the channel no longer has it),
//! failed), and while pending, `source`: where to fetch it (`wa`: the WhatsApp bridge's details,
//! `url`, `gmail`: {message, attachment}). A string in the list is something that isn't a file
//! (a location, a contact, a poll), or a message from before files were kept.
//!
//! Every file is fetched right after its message is stored (`fetch_soon`); what didn't make it
//! is tried again by the worker's sweep (`retry`), each try later than the one before (`retry_at`
//! on its entry) for some hours, then it is `failed`. A voice note, once stored, is
//! heard (`listen`: its words on its entry). The apps get each stored file
//! with a signed link (`sign`), or the file itself to save (`download`).
//!
//! What the user sends from the Inbox (a photo, a video, a file) is stored the same way first
//! (`put_outgoing`, already `stored`): the chat shows it from there, and its channel's connector
//! takes it from there (`own_file`, `bytes`, `link`) to send it.
//!
//! Files are kept for the user's `media_days` (an Inbox setting, `KEEP_DAYS` by default) after
//! their message: then they leave storage (`expire`) and the entry says `expired`. A message
//! already older than that (history) never fetches its files.

use std::path::PathBuf;
use std::sync::LazyLock;
use std::time::Duration;

use aws_sdk_s3::primitives::ByteStream;
use base64::Engine;
use chrono::{DateTime, Datelike, Utc};
use futures_util::StreamExt;
use serde_json::{json, Value as Json};
use tokio::io::AsyncWriteExt;
use uuid::Uuid;

use crate::apps::pigeon::connectors::{gmail, whatsapp};
use crate::apps::pigeon::state::{self, State};
use crate::apps::storage::handlers::{download_url, s3_client};
use crate::db::db::DbPool;

/// How many files are fetched at once (a history brings many).
static FETCHING: LazyLock<tokio::sync::Semaphore> = LazyLock::new(|| tokio::sync::Semaphore::new(3));
/// Tries before a file is given up as failed: each waits twice the one before (`wait`), about
/// six hours in all, so storage or a channel that is down for a while doesn't cost the file.
const TRIES: i64 = 12;
/// How long a signed link lasts.
const LINK_SECS: i64 = 24 * 3600;
/// How long files are kept after their message, unless the user chose (`media_days`).
pub const KEEP_DAYS: i64 = 90;
/// The lengths the user can choose.
pub const KEEP_CHOICES: [i64; 4] = [30, 90, 180, 365];

/// How many days the user's files are kept.
pub async fn keep_days(pool: &DbPool, user: &str) -> anyhow::Result<i64> {
    let v: Option<Json> = sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = 'media_days'")
        .bind(user)
        .fetch_optional(pool)
        .await?;
    Ok(v.and_then(|v| v.as_i64()).filter(|d| *d > 0).unwrap_or(KEEP_DAYS))
}

pub async fn set_keep_days(pool: &DbPool, user: &str, days: i64) -> anyhow::Result<()> {
    if !KEEP_CHOICES.contains(&days) {
        anyhow::bail!("media is kept 30, 90, 180 or 365 days");
    }
    sqlx::query(
        "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($1, 'media_days', $2, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    )
    .bind(user)
    .bind(json!(days))
    .execute(pool)
    .await?;
    Ok(())
}

/// Files past their user's keeping time: out of storage (file and preview), their entries
/// `expired`; pending ones that late are dropped unfetched. How many messages.
pub async fn expire(st: &State) -> anyhow::Result<usize> {
    let due: Vec<(Uuid, Json)> = sqlx::query_as(
        "SELECT i.id, i.media FROM db_pigeon_items i
           JOIN db_pigeon_conversations c ON c.id = i.conversation_id
           LEFT JOIN db_pigeon_settings s ON s.user_id = c.user_id AND s.key = 'media_days'
          WHERE (i.media @> '[{\"status\": \"stored\"}]'::jsonb OR i.media @> '[{\"status\": \"pending\"}]'::jsonb)
            AND i.at < NOW() - make_interval(days => COALESCE((s.value #>> '{}')::int, $1::int))
          LIMIT 200",
    )
    .bind(KEEP_DAYS as i32)
    .fetch_all(&st.pool)
    .await?;
    if due.is_empty() {
        return Ok(0);
    }
    let (client, bucket) = s3_client(&st.pool).await.map_err(|e| anyhow::anyhow!(e))?;
    for (item, media) in &due {
        for m in media.as_array().into_iter().flatten().filter(|m| m["status"] == "stored" || m["status"] == "pending") {
            let Some(id) = m["id"].as_str() else { continue };
            for key in [m["key"].as_str(), m["thumb"].as_str()].into_iter().flatten() {
                if let Err(e) = client.delete_object().bucket(&bucket).key(key).send().await {
                    anyhow::bail!("deleting {key}: {e}");
                }
            }
            update(&st.pool, *item, id, &json!({ "status": "expired", "key": null, "thumb": null, "source": null, "error": null })).await?;
        }
    }
    Ok(due.len())
}

/// A stored file, to save: its type, name and bytes as they come from storage.
pub async fn download(pool: &DbPool, user: &str, item: Uuid, id: &str) -> anyhow::Result<(String, String, ByteStream)> {
    let media: Option<Json> = sqlx::query_scalar(
        "SELECT i.media FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id WHERE i.id = $1 AND c.user_id = $2",
    )
    .bind(item)
    .bind(user)
    .fetch_optional(pool)
    .await?;
    let m = media
        .as_ref()
        .and_then(|m| m.as_array())
        .and_then(|a| a.iter().find(|m| m["id"] == id))
        .ok_or_else(|| anyhow::anyhow!("no such file"))?;
    let key = m["key"].as_str().filter(|_| m["status"] == "stored").ok_or_else(|| anyhow::anyhow!("this file isn't kept any more"))?;
    let (client, bucket) = s3_client(pool).await.map_err(|e| anyhow::anyhow!(e))?;
    let obj = client.get_object().bucket(&bucket).key(key).send().await.map_err(|e| anyhow::anyhow!("reading it: {e}"))?;
    let name = m["name"].as_str().map(str::to_string).unwrap_or_else(|| key.rsplit('/').next().unwrap_or("file").to_string());
    let mime = m["mime"].as_str().unwrap_or("application/octet-stream").to_string();
    Ok((mime, name, obj.body))
}

/// A new file of a message, to fetch: its entry in the message's `media`.
#[allow(clippy::too_many_arguments)]
pub fn entry(user: &str, connector: &str, at: DateTime<Utc>, kind: &str, label: &str, mime: Option<&str>, name: Option<&str>, source: Json) -> Json {
    let id = Uuid::new_v4();
    let ext = extension(mime, name);
    let dir = format!("pigeon/{user}/media/{connector}/{:04}/{:02}", at.year(), at.month());
    json!({
        "id": id,
        "kind": kind,
        "label": label,
        "mime": mime,
        "name": name.filter(|n| !n.trim().is_empty()),
        "key": format!("{dir}/{id}.{ext}"),
        "status": "pending",
        "source": source,
    })
}

/// The largest file the user sends: under Cloudflare's 100 MB a request (WhatsApp takes a video
/// up to 100 MB; Gmail and Instagram take less, and say so).
pub const MAX_SEND_BYTES: i64 = 95 << 20;

/// What a file the user sends is, by its type: image, video, audio, or document.
pub fn kind_of(mime: &str) -> &'static str {
    let base = mime.split(';').next().unwrap_or_default().trim();
    match base {
        "image/jpeg" | "image/png" | "image/webp" => "image",
        b if b.starts_with("video/") => "video",
        b if b.starts_with("audio/") => "audio",
        _ => "document",
    }
}

/// A message's files as a tool tells them: what each is, a voice note's words, and its id (the
/// file itself is `/admin/pigeon/items/{item}/media/{id}`); never where it's kept or fetched from.
pub fn told(media: &Json) -> Vec<Json> {
    let Some(list) = media.as_array() else { return vec![] };
    list.iter()
        .filter(|m| m.is_object())
        .map(|m| {
            let mut o = serde_json::Map::new();
            for k in ["id", "kind", "name", "mime", "size", "seconds", "status", "transcript"] {
                if !m[k].is_null() {
                    o.insert(k.into(), m[k].clone());
                }
            }
            Json::Object(o)
        })
        .collect()
}

/// The words a message's body has for a file ("image", "document: Report.pdf").
pub fn label_of(kind: &str, name: Option<&str>) -> String {
    match kind {
        "document" => format!("document: {}", name.unwrap_or("file")),
        "voice" => "voice message".into(),
        k => k.to_string(),
    }
}

/// A sent file's message body: its caption, then the file in words.
pub fn body_with(caption: &str, file: &Json) -> String {
    let label = format!("[{}]", file["label"].as_str().unwrap_or("attachment"));
    if caption.trim().is_empty() {
        label
    } else {
        format!("{}\n{label}", caption.trim())
    }
}

/// A file the user sends from the Inbox (at `path`, a temporary file), into storage: its entry,
/// stored. `dims`: its width, height and seconds, where known.
#[allow(clippy::too_many_arguments)]
pub async fn put_outgoing(
    pool: &DbPool,
    user: &str,
    connector: &str,
    mime: &str,
    name: Option<&str>,
    path: &std::path::Path,
    size: i64,
    dims: &[(&str, u64)],
) -> anyhow::Result<Json> {
    let kind = kind_of(mime);
    let mut e = entry(user, connector, Utc::now(), kind, &label_of(kind, name), Some(mime), name, Json::Null);
    let key = e["key"].as_str().unwrap_or_default().to_string();
    let (client, bucket) = s3_client(pool).await.map_err(|e| anyhow::anyhow!(e))?;
    let body = ByteStream::from_path(path).await.map_err(|e| anyhow::anyhow!("reading the upload: {e}"))?;
    client.put_object().bucket(&bucket).key(&key).body(body).content_type(mime).send().await.map_err(|e| anyhow::anyhow!(unstored(e)))?;
    if let Some(o) = e.as_object_mut() {
        o.remove("source");
        o.insert("status".into(), json!("stored"));
        o.insert("size".into(), json!(size));
        for (k, n) in dims.iter().filter(|(_, n)| *n > 0) {
            o.insert((*k).into(), json!(n));
        }
    }
    Ok(e)
}

/// A stored file that turned out not to be sent: out of storage again (best effort).
pub async fn remove(pool: &DbPool, key: &str) {
    if let Ok((client, bucket)) = s3_client(pool).await {
        let _ = client.delete_object().bucket(&bucket).key(key).send().await;
    }
}

/// The file an action sends (`args.file`, from `put_outgoing`): only a stored one of this
/// user's own, whoever asks.
pub fn own_file<'a>(user: &str, args: &'a Json) -> anyhow::Result<&'a Json> {
    let f = &args["file"];
    let key = f["key"].as_str().unwrap_or_default();
    if f["status"] != "stored" || !key.starts_with(&format!("pigeon/{user}/media/")) || key.contains("..") {
        anyhow::bail!("file: one the user uploaded to send");
    }
    Ok(f)
}

/// A stored file's bytes.
pub async fn bytes(pool: &DbPool, key: &str) -> anyhow::Result<Vec<u8>> {
    let (client, bucket) = s3_client(pool).await.map_err(|e| anyhow::anyhow!(e))?;
    let obj = client.get_object().bucket(&bucket).key(key).send().await.map_err(|e| anyhow::anyhow!("reading it: {e}"))?;
    Ok(obj.body.collect().await.map_err(|e| anyhow::anyhow!("reading it: {e}"))?.into_bytes().to_vec())
}

/// A stored file at a link anyone can fetch for an hour (a channel that takes files by URL).
pub async fn link(pool: &DbPool, key: &str) -> anyhow::Result<String> {
    let (client, bucket) = s3_client(pool).await.map_err(|e| anyhow::anyhow!(e))?;
    Ok(download_url(pool, &client, &bucket, key, 3600).await.map_err(|e| anyhow::anyhow!(e))?.0)
}

/// A file's extension: its name's, else its type's.
fn extension(mime: Option<&str>, name: Option<&str>) -> String {
    if let Some(e) = name.and_then(|n| n.rsplit_once('.')).map(|(_, e)| e.to_lowercase()).filter(|e| !e.is_empty() && e.len() <= 8 && e.chars().all(|c| c.is_ascii_alphanumeric())) {
        return e;
    }
    let base = mime.unwrap_or_default().split(';').next().unwrap_or_default().trim();
    match base {
        "image/jpeg" => "jpg",
        "image/png" => "png",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "image/heic" => "heic",
        "video/mp4" => "mp4",
        "video/3gpp" => "3gp",
        "video/quicktime" => "mov",
        "audio/ogg" => "ogg",
        "audio/mpeg" => "mp3",
        "audio/mp4" | "audio/aac" => "m4a",
        "audio/amr" => "amr",
        "application/pdf" => "pdf",
        _ => "bin",
    }
    .to_string()
}

/// The pending files of a message: fetch them now, in the background.
pub fn fetch_soon(pool: &DbPool, item: Uuid, media: &Json) {
    if !has_pending(media) {
        return;
    }
    let st = state::shared(pool);
    tokio::spawn(async move {
        if let Err(e) = fetch(&st, item).await {
            log::warn!("pigeon media of {item}: {e:#}");
        }
    });
}

fn has_pending(media: &Json) -> bool {
    media.as_array().is_some_and(|a| a.iter().any(|m| m["status"] == "pending"))
}

/// Messages whose files are still pending (their fetch failed, or the process stopped): tried again.
pub async fn retry(st: &State) -> anyhow::Result<usize> {
    let items: Vec<Uuid> = sqlx::query_scalar(
        "SELECT id FROM db_pigeon_items WHERE media @> '[{\"status\": \"pending\"}]'::jsonb AND created_at < NOW() - INTERVAL '2 minutes'
            AND EXISTS (SELECT 1 FROM jsonb_array_elements(media) e WHERE jsonb_typeof(e) = 'object' AND e->>'status' = 'pending'
                         AND COALESCE((e->>'retry_at')::timestamptz, '-infinity') <= NOW())
          ORDER BY created_at DESC LIMIT 20",
    )
    .fetch_all(&st.pool)
    .await?;
    for &item in &items {
        if let Err(e) = fetch(st, item).await {
            log::warn!("pigeon media of {item}: {e:#}");
        }
    }
    Ok(items.len())
}

/// Why a file couldn't be had.
pub(crate) enum Miss {
    /// the channel no longer has it (for good)
    Gone(String),
    /// worth another try
    Failed(String),
}

/// How long a file waits after its nth failed try: 1 minute, 2, 4… an hour at most.
fn wait(tries: i64) -> chrono::Duration {
    chrono::Duration::minutes((1i64 << (tries - 1).clamp(0, 6)).min(60))
}

/// Storage refused a file: the whole cause to the log (the SDK's own words are "dispatch failure").
fn unstored<E: std::error::Error>(e: E) -> String {
    log::warn!("pigeon media: storing a file: {}", aws_sdk_s3::error::DisplayErrorContext(&e));
    format!("storing it: {e}")
}


/// Fetch a message's pending files into storage, one by one, each entry updated as it goes.
async fn fetch(st: &State, item: Uuid) -> anyhow::Result<()> {
    let row: Option<(String, Uuid, Json)> = sqlx::query_as(
        "SELECT c.user_id, c.id, i.media FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id WHERE i.id = $1",
    )
    .bind(item)
    .fetch_optional(&st.pool)
    .await?;
    let Some((user, conversation, media)) = row else { return Ok(()) };
    // a message older than the user keeps files for: nothing to fetch
    let old: bool = sqlx::query_scalar("SELECT at < NOW() - make_interval(days => $2::int) FROM db_pigeon_items WHERE id = $1")
        .bind(item)
        .bind(keep_days(&st.pool, &user).await? as i32)
        .fetch_one(&st.pool)
        .await?;
    if old {
        for m in media.as_array().into_iter().flatten().filter(|m| m["status"] == "pending") {
            if let Some(id) = m["id"].as_str() {
                update(&st.pool, item, id, &json!({ "status": "expired", "key": null, "source": null })).await?;
            }
        }
        return Ok(());
    }
    for m in media.as_array().into_iter().flatten().filter(|m| m["status"] == "pending") {
        let Some(id) = m["id"].as_str() else { continue };
        // its next try isn't due yet
        if m["retry_at"].as_str().and_then(|t| t.parse::<DateTime<Utc>>().ok()).is_some_and(|t| t > Utc::now()) {
            continue;
        }
        let _turn = FETCHING.acquire().await?;
        let patch = match keep(st, &user, item, m).await {
            Ok(size) => json!({ "status": "stored", "size": size, "source": null, "error": null, "retry_at": null }),
            Err(Miss::Gone(why)) => json!({ "status": "gone", "source": null, "error": why, "retry_at": null }),
            Err(Miss::Failed(why)) => {
                let tries = m["tries"].as_i64().unwrap_or(0) + 1;
                log::info!("pigeon media {id} of {item}: try {tries}: {why}");
                if tries >= TRIES {
                    json!({ "status": "failed", "tries": tries, "source": null, "error": why, "retry_at": null })
                } else {
                    json!({ "tries": tries, "error": why, "retry_at": (Utc::now() + wait(tries)).to_rfc3339_opts(chrono::SecondsFormat::Secs, true) })
                }
            }
        };
        update(&st.pool, item, id, &patch).await?;
    }
    // a voice note's words
    if media.as_array().into_iter().flatten().any(crate::apps::pigeon::listen::hearable) {
        crate::apps::pigeon::listen::soon(&st.pool, item);
    }
    // the chat shows them
    crate::apps::pigeon::events::publish(&st.pool, &user, "conversation", Some(conversation)).await;
    Ok(())
}

/// One entry of a message's media changed (`patch`'s nulls remove).
pub(crate) async fn update(pool: &DbPool, item: Uuid, id: &str, patch: &Json) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE db_pigeon_items SET media = (
            SELECT jsonb_agg(CASE WHEN jsonb_typeof(e) = 'object' AND e->>'id' = $2 THEN jsonb_strip_nulls(e || $3) ELSE e END ORDER BY n)
              FROM jsonb_array_elements(media) WITH ORDINALITY AS x(e, n))
          WHERE id = $1",
    )
    .bind(item)
    .bind(id)
    .bind(patch)
    .execute(pool)
    .await?;
    Ok(())
}

/// A file from its channel into storage (its preview too): its size.
async fn keep(st: &State, user: &str, item: Uuid, m: &Json) -> Result<i64, Miss> {
    let key = m["key"].as_str().ok_or_else(|| Miss::Gone("no key".into()))?;
    let mime = m["mime"].as_str().unwrap_or("application/octet-stream");
    let source = &m["source"];
    let (client, bucket) = s3_client(&st.pool).await.map_err(Miss::Failed)?;

    // the preview first: small, and the chat shows it while the file comes
    if let Some(t) = source["wa"]["thumb"].as_str().filter(|t| !t.is_empty()) {
        if let Ok(bytes) = base64::engine::general_purpose::STANDARD.decode(t) {
            let thumb = thumb_key(key);
            if client.put_object().bucket(&bucket).key(&thumb).body(ByteStream::from(bytes)).content_type("image/jpeg").send().await.is_ok() {
                if let Some(id) = m["id"].as_str() {
                    let _ = update(&st.pool, item, id, &json!({ "thumb": thumb })).await;
                }
            }
        }
    }

    let tmp = std::env::temp_dir().join(format!("pigeon-media-{}", Uuid::new_v4()));
    let got = if source["wa"].is_object() {
        let mut wa = source["wa"].clone();
        if let Some(o) = wa.as_object_mut() {
            o.remove("thumb");
        }
        match whatsapp::media(st, user, &wa).await {
            Ok(resp) => save(resp, &tmp).await,
            Err(e) => Err(e),
        }
    } else if let Some(url) = source["url"].as_str() {
        match http().get(url).send().await {
            Ok(r) if r.status().as_u16() == 404 || r.status().as_u16() == 410 || r.status().as_u16() == 403 => {
                Err(Miss::Gone(format!("{}", r.status())))
            }
            Ok(r) if r.status().is_success() => save(r, &tmp).await,
            Ok(r) => Err(Miss::Failed(format!("{}", r.status()))),
            Err(e) => Err(Miss::Failed(e.to_string())),
        }
    } else if source["gmail"].is_object() {
        let (mid, aid) = (source["gmail"]["message"].as_str().unwrap_or_default(), source["gmail"]["attachment"].as_str().unwrap_or_default());
        match gmail::attachment(st, user, item, mid, aid).await {
            Ok(bytes) => tokio::fs::write(&tmp, &bytes).await.map(|_| bytes.len() as i64).map_err(|e| Miss::Failed(e.to_string())),
            Err(e) => Err(Miss::Failed(format!("{e:#}"))),
        }
    } else {
        Err(Miss::Gone("nowhere to fetch it from".into()))
    };
    let size = match got {
        Ok(n) => n,
        Err(e) => {
            let _ = tokio::fs::remove_file(&tmp).await;
            return Err(e);
        }
    };
    let up = match ByteStream::from_path(&tmp).await {
        Ok(body) => client.put_object().bucket(&bucket).key(key).body(body).content_type(mime).send().await.map(|_| ()).map_err(|e| Miss::Failed(unstored(e))),
        Err(e) => Err(Miss::Failed(format!("reading it back: {e}"))),
    };
    let _ = tokio::fs::remove_file(&tmp).await;
    up.map(|_| size)
}

/// A response's body to a file, as it comes (a video can be large): its size.
async fn save(resp: reqwest::Response, to: &PathBuf) -> Result<i64, Miss> {
    let mut file = tokio::fs::File::create(to).await.map_err(|e| Miss::Failed(e.to_string()))?;
    let mut stream = resp.bytes_stream();
    let mut n: i64 = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| Miss::Failed(format!("downloading: {e}")))?;
        n += chunk.len() as i64;
        file.write_all(&chunk).await.map_err(|e| Miss::Failed(e.to_string()))?;
    }
    file.flush().await.map_err(|e| Miss::Failed(e.to_string()))?;
    Ok(n)
}

/// The bridge's answer for a file: the file, or why not.
pub(crate) fn bridge_miss(status: reqwest::StatusCode, why: String) -> Miss {
    if status == reqwest::StatusCode::GONE {
        Miss::Gone(why)
    } else {
        Miss::Failed(format!("{status} {why}"))
    }
}

fn thumb_key(key: &str) -> String {
    match key.rsplit_once('.') {
        Some((base, _)) => format!("{base}.thumb.jpg"),
        None => format!("{key}.thumb.jpg"),
    }
}

fn http() -> &'static reqwest::Client {
    static C: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    C.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(30 * 60)).build().expect("http client"))
}

/// Messages (JSON, each with `media`) as the apps get them: every stored file with a signed link
/// (`url`, and `thumb_url` for its preview), the fetch details left out.
pub async fn sign(pool: &DbPool, items: &mut [Json]) {
    let any = items.iter().any(|i| i["media"].as_array().is_some_and(|a| a.iter().any(|m| m.is_object())));
    if !any {
        return;
    }
    let s3 = s3_client(pool).await.ok();
    for i in items.iter_mut() {
        let Some(list) = i["media"].as_array_mut() else { continue };
        for m in list.iter_mut().filter(|m| m.is_object()) {
            if let Some(o) = m.as_object_mut() {
                o.remove("source");
            }
            let Some((client, bucket)) = &s3 else { continue };
            for (field, link) in [("key", "url"), ("thumb", "thumb_url")] {
                let stored = field == "thumb" || m["status"] == "stored";
                if let (true, Some(key)) = (stored, m[field].as_str().map(str::to_string)) {
                    if let Ok((url, _)) = download_url(pool, client, bucket, &key, LINK_SECS).await {
                        m[link] = json!(url);
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn each_try_waits_longer_up_to_an_hour() {
        let minutes: Vec<i64> = (1..TRIES).map(|n| wait(n).num_minutes()).collect();
        assert_eq!(minutes, vec![1, 2, 4, 8, 16, 32, 60, 60, 60, 60, 60]);
    }

    #[test]
    fn a_tool_is_told_what_a_file_is_not_where() {
        let media = json!([
            "location",
            { "id": "f1", "kind": "image", "mime": "image/jpeg", "name": null, "size": 10, "status": "stored",
              "key": "pigeon/u1/media/whatsapp/2026/11/f1.jpg", "source": { "url": "https://x" } },
        ]);
        assert_eq!(told(&media), vec![json!({ "id": "f1", "kind": "image", "mime": "image/jpeg", "size": 10, "status": "stored" })]);
        assert!(told(&json!(null)).is_empty());
    }

    #[test]
    fn keys_by_channel_and_month() {
        let at = DateTime::parse_from_rfc3339("2026-11-04T01:00:00Z").unwrap().with_timezone(&Utc);
        let e = entry("u1", "whatsapp", at, "image", "image", Some("image/jpeg"), None, json!({}));
        let key = e["key"].as_str().unwrap();
        assert!(key.starts_with("pigeon/u1/media/whatsapp/2026/11/"), "{key}");
        assert!(key.ends_with(&format!("{}.jpg", e["id"].as_str().unwrap())), "{key}");
        assert_eq!(thumb_key(key), key.replace(".jpg", ".thumb.jpg"));
    }

    #[test]
    fn only_the_users_own_stored_files_are_sent() {
        let f = |key: &str, status: &str| json!({ "file": { "key": key, "status": status } });
        assert!(own_file("u1", &f("pigeon/u1/media/whatsapp/2026/11/a.jpg", "stored")).is_ok());
        assert!(own_file("u1", &f("pigeon/u2/media/whatsapp/2026/11/a.jpg", "stored")).is_err(), "another user's");
        assert!(own_file("u1", &f("pigeon/u1/media/../../u2/a.jpg", "stored")).is_err(), "out of the folder");
        assert!(own_file("u1", &f("pigeon/u1/media/whatsapp/2026/11/a.jpg", "pending")).is_err(), "not stored");
        assert!(own_file("u1", &json!({})).is_err());
    }

    #[test]
    fn what_a_sent_file_is() {
        assert_eq!(kind_of("image/jpeg"), "image");
        assert_eq!(kind_of("image/gif"), "document");
        assert_eq!(kind_of("video/mp4"), "video");
        assert_eq!(kind_of("audio/mpeg"), "audio");
        assert_eq!(kind_of("application/pdf"), "document");
        let file = json!({ "label": "image" });
        assert_eq!(body_with("", &file), "[image]");
        assert_eq!(body_with(" look ", &file), "look\n[image]");
    }

    #[test]
    fn extension_from_the_name_first() {
        assert_eq!(extension(Some("application/octet-stream"), Some("Report.PDF")), "pdf");
        assert_eq!(extension(Some("audio/ogg; codecs=opus"), None), "ogg");
        assert_eq!(extension(None, Some("no extension")), "bin");
    }
}

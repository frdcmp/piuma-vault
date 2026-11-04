//! Profile pictures: each person's, found on the channels they're on (WhatsApp's, then
//! Instagram's, then Gravatar's for an email address), kept in storage beside its pixel-art copy:
//!
//!   pigeon/<user>/avatars/<contact>.jpg      the photo
//!   pigeon/<user>/avatars/<contact>.px.png   24×24, drawn at 192×192 with hard pixels
//!
//! The contact's `avatar_key` is the photo's key (None: none found), `avatar_at` when it was last
//! looked for. The worker's sweep looks for the new (`avatar_at` NULL) and, weekly, again.

use std::time::Duration;

use aws_sdk_s3::primitives::ByteStream;
use image::imageops::FilterType;
use serde_json::Value as Json;
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::apps::pigeon::connectors::{instagram, whatsapp};
use crate::apps::pigeon::state::State;
use crate::apps::storage::handlers::{download_url, s3_client};
use crate::db::db::DbPool;

/// People looked for per sweep (a minute apart): the channels are asked one person at a time.
const PER_SWEEP: i64 = 10;
/// The pixel art's size, and the size it's drawn at.
const PIXELS: u32 = 24;
const DRAWN: u32 = 192;
/// How long a picture's link lasts.
const LINK_SECS: i64 = 24 * 3600;

/// The pixel-art copy's key, beside the photo.
pub fn pixel_key(key: &str) -> String {
    match key.rsplit_once('.') {
        Some((base, _)) => format!("{base}.px.png"),
        None => format!("{key}.px.png"),
    }
}

/// The people whose picture is due: never looked for, or a week ago. How many got one.
pub async fn sweep(st: &State) -> anyhow::Result<usize> {
    let due: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, user_id FROM db_pigeon_contacts
          WHERE avatar_at IS NULL OR avatar_at < NOW() - INTERVAL '7 days'
          ORDER BY avatar_at NULLS FIRST, updated_at DESC LIMIT $1",
    )
    .bind(PER_SWEEP)
    .fetch_all(&st.pool)
    .await?;
    let mut n = 0;
    for (id, user) in due {
        match refresh(st, &user, id).await {
            Ok(true) => n += 1,
            Ok(false) => {}
            Err(e) => log::warn!("pigeon avatar of {id}: {e:#}"),
        }
    }
    Ok(n)
}

/// Look for a person's picture now: the first their channels give, kept. False: none found
/// (a picture kept before stays).
pub async fn refresh(st: &State, user: &str, contact: Uuid) -> anyhow::Result<bool> {
    let handles: Vec<(String, String)> =
        sqlx::query_as("SELECT connector, handle FROM db_pigeon_contact_handles WHERE contact_id = $1 ORDER BY connector, handle")
            .bind(contact)
            .fetch_all(&st.pool)
            .await?;
    // WhatsApp's, then Instagram's, then Gravatar's
    let mut sources: Vec<String> = Vec::new();
    for (ch, h) in &handles {
        if ch == "whatsapp" && h.starts_with('+') {
            if let Some(u) = whatsapp::picture_url(st, user, h).await {
                sources.push(u);
            }
        }
    }
    for (ch, h) in &handles {
        if ch == "instagram" && !h.starts_with('@') {
            if let Some(u) = instagram::picture_url(st, user, h).await {
                sources.push(u);
            }
        }
    }
    for (_, h) in &handles {
        if h.contains('@') && !h.starts_with('@') {
            sources.push(gravatar(h));
        }
    }
    for url in sources {
        if let Some(bytes) = fetch(&url).await {
            match keep(&st.pool, user, contact, &bytes).await {
                Ok(()) => return Ok(true),
                Err(e) => log::info!("pigeon avatar of {contact}: {e:#}"),
            }
        }
    }
    sqlx::query("UPDATE db_pigeon_contacts SET avatar_at = NOW() WHERE id = $1").bind(contact).execute(&st.pool).await?;
    Ok(false)
}

/// Gravatar's picture of an email address (none: a 404).
fn gravatar(email: &str) -> String {
    let hash = hex::encode(Sha256::digest(email.trim().to_lowercase().as_bytes()));
    format!("https://gravatar.com/avatar/{hash}?s=256&d=404")
}

async fn fetch(url: &str) -> Option<Vec<u8>> {
    static HTTP: std::sync::OnceLock<reqwest::Client> = std::sync::OnceLock::new();
    let http = HTTP.get_or_init(|| reqwest::Client::builder().timeout(Duration::from_secs(20)).build().expect("http client"));
    let r = http.get(url).send().await.ok()?;
    if !r.status().is_success() {
        return None;
    }
    r.bytes().await.ok().map(|b| b.to_vec()).filter(|b| !b.is_empty() && b.len() < 10 << 20)
}

/// The photo and its pixel art into storage, the contact pointing at them.
async fn keep(pool: &DbPool, user: &str, contact: Uuid, bytes: &[u8]) -> anyhow::Result<()> {
    let (photo, px) = tokio::task::spawn_blocking({
        let bytes = bytes.to_vec();
        move || draw(&bytes)
    })
    .await??;
    let (client, bucket) = s3_client(pool).await.map_err(|e| anyhow::anyhow!(e))?;
    let key = format!("pigeon/{user}/avatars/{contact}.jpg");
    for (k, body, mime) in [(key.clone(), photo, "image/jpeg"), (pixel_key(&key), px, "image/png")] {
        client
            .put_object()
            .bucket(&bucket)
            .key(&k)
            .body(ByteStream::from(body))
            .content_type(mime)
            .send()
            .await
            .map_err(|e| anyhow::anyhow!("storing {k}: {e}"))?;
    }
    sqlx::query("UPDATE db_pigeon_contacts SET avatar_key = $2, avatar_at = NOW() WHERE id = $1").bind(contact).bind(&key).execute(pool).await?;
    Ok(())
}

/// A picture as a square JPEG photo, and as pixel art (PNG).
fn draw(bytes: &[u8]) -> anyhow::Result<(Vec<u8>, Vec<u8>)> {
    let img = image::load_from_memory(bytes)?;
    let side = img.width().min(img.height());
    let square = img.crop_imm((img.width() - side) / 2, (img.height() - side) / 2, side, side);
    let photo = square.resize_exact(side.min(640), side.min(640), FilterType::Lanczos3).to_rgb8();
    let mut jpg = Vec::new();
    image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, 85).encode_image(&photo)?;
    let px = square.resize_exact(PIXELS, PIXELS, FilterType::Triangle).resize_exact(DRAWN, DRAWN, FilterType::Nearest).to_rgba8();
    let mut png = Vec::new();
    px.write_to(&mut std::io::Cursor::new(&mut png), image::ImageFormat::Png)?;
    Ok((jpg, png))
}

/// Signed links to people's pictures, for one response (the storage client made once).
pub struct Links {
    s3: Option<(aws_sdk_s3::Client, String)>,
}

impl Links {
    pub async fn new(pool: &DbPool) -> Self {
        Self { s3: s3_client(pool).await.ok() }
    }

    /// `{avatar, avatar_photo}`: the pixel art's link and the photo's (None: no picture).
    pub async fn of(&self, pool: &DbPool, key: Option<&str>) -> (Option<String>, Option<String>) {
        let (Some(key), Some((client, bucket))) = (key, &self.s3) else { return (None, None) };
        let link = |k: String| async move { download_url(pool, client, bucket, &k, LINK_SECS).await.ok().map(|(u, _)| u) };
        (link(pixel_key(key)).await, link(key.to_string()).await)
    }

    /// The same, as fields to add to a JSON object.
    pub async fn add(&self, pool: &DbPool, key: Option<&str>, to: &mut Json) {
        let (px, photo) = self.of(pool, key).await;
        to["avatar"] = serde_json::json!(px);
        to["avatar_photo"] = serde_json::json!(photo);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pixel_art_is_square_and_blocky() {
        let mut src = image::RgbImage::new(300, 200);
        for (x, _, p) in src.enumerate_pixels_mut() {
            *p = image::Rgb([(x % 256) as u8, 40, 200]);
        }
        let mut bytes = Vec::new();
        image::DynamicImage::ImageRgb8(src).write_to(&mut std::io::Cursor::new(&mut bytes), image::ImageFormat::Png).unwrap();
        let (jpg, png) = draw(&bytes).unwrap();
        let photo = image::load_from_memory(&jpg).unwrap();
        assert_eq!((photo.width(), photo.height()), (200, 200));
        let px = image::load_from_memory(&png).unwrap().to_rgba8();
        assert_eq!((px.width(), px.height()), (DRAWN, DRAWN));
        // one pixel of the art is a block of 8×8 the same colour
        assert_eq!(px.get_pixel(0, 0), px.get_pixel(7, 7));
    }

    #[test]
    fn keys_and_gravatar() {
        assert_eq!(pixel_key("pigeon/u/avatars/c.jpg"), "pigeon/u/avatars/c.px.png");
        assert!(gravatar(" Someone@Example.com ").starts_with("https://gravatar.com/avatar/"));
        assert_eq!(gravatar("a@b.c"), gravatar("A@B.C "));
    }
}

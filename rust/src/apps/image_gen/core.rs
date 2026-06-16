//! The generate-and-store pipeline shared by the HTTP API and the agent tool:
//! resolve the provider → generate → upload each image to S3 (reusing the
//! storage app's S3 client) → record a `db_generated_images` row → return the
//! stored images with a stable delivery URL.

use aws_sdk_s3::primitives::ByteStream;
use uuid::Uuid;

use crate::apps::storage::handlers::{download_url, s3_client};
use crate::db::db::DbPool;

use super::config;
use super::models::StoredImage;
use super::providers::{self, ext_for_mime, GenOptions};

// Generated images are embedded in notes/chat long-term, so the delivery URL
// needs a long life. On a token-auth CDN this is a signed URL valid for ~10
// years (a tokenless URL is rejected — the zone enforces tokens); without a
// token key it's a plain CDN URL; on S3-only it falls back to a presigned GET
// (SDK-capped at 7 days). The notes editor stores resize width in the URL
// *fragment* (`#w=`), never the query string, so it can't invalidate the token.
const URL_TTL_SECS: i64 = 10 * 365 * 24 * 60 * 60;

/// Generate `n` images for `prompt`, store them, and return the records.
/// `source` is `"api"` or `"agent_tool"` (audit/history only).
pub async fn generate_and_store(
    pool: &DbPool,
    user_id: &str,
    prompt: &str,
    size: &str,
    n: u8,
    source: &str,
) -> Result<Vec<StoredImage>, String> {
    let cfg = config::resolve(pool).await?;
    let opts = GenOptions {
        prompt,
        size,
        n: n.clamp(1, 4),
        model: &cfg.model,
    };
    let images =
        providers::generate(&cfg.kind, &cfg.api_key, cfg.base_url.as_deref(), &opts).await?;

    let (client, bucket) = s3_client(pool).await?;

    let mut stored = Vec::with_capacity(images.len());
    for img in images {
        let id = Uuid::new_v4();
        let key = format!("generated/{user_id}/{id}.{}", ext_for_mime(&img.mime));

        client
            .put_object()
            .bucket(&bucket)
            .key(&key)
            .body(ByteStream::from(img.bytes))
            .content_type(&img.mime)
            .send()
            .await
            .map_err(|e| format!("store image: {e}"))?;

        let (cdn_url, _) = download_url(pool, &client, &bucket, &key, URL_TTL_SECS).await?;

        sqlx::query(
            "INSERT INTO db_generated_images
               (id, user_id, prompt, revised_prompt, provider, model, size, storage_key, cdn_url, mime, source)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)",
        )
        .bind(id)
        .bind(user_id)
        .bind(prompt)
        .bind(&img.revised_prompt)
        .bind(&cfg.kind)
        .bind(&cfg.model)
        .bind(size)
        .bind(&key)
        .bind(&cdn_url)
        .bind(&img.mime)
        .bind(source)
        .execute(pool)
        .await
        .map_err(|e| format!("record image: {e}"))?;

        stored.push(StoredImage {
            id,
            prompt: prompt.to_string(),
            revised_prompt: img.revised_prompt,
            provider: cfg.kind.clone(),
            model: cfg.model.clone(),
            size: size.to_string(),
            storage_key: key,
            cdn_url,
            mime: img.mime,
            source: source.to_string(),
        });
    }
    Ok(stored)
}

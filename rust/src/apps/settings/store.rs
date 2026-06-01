//! Read/write for the single-tenant `app_settings` key-value table, plus
//! typed resolvers for the services whose config lives in the DB (Azure
//! embeddings, OpenClaw). Config is sourced exclusively from the DB — set it in
//! the Services dashboard.

use crate::db::db::DbPool;

// Setting keys (single source of truth, shared by handlers + resolvers).
pub const AZURE_EMBEDDING_URL: &str = "azure_embedding_url";
pub const AZURE_EMBEDDING_API_KEY: &str = "azure_embedding_api_key";
pub const OPENCLAW_URL: &str = "openclaw_url";
pub const OPENCLAW_GATEWAY_TOKEN: &str = "openclaw_gateway_token";
// Generic S3 / AWS object storage (works with AWS S3, Bunny, R2, MinIO, …).
pub const S3_ENDPOINT: &str = "s3_endpoint";
pub const S3_REGION: &str = "s3_region";
pub const S3_BUCKET: &str = "s3_bucket";
pub const S3_ACCESS_KEY_ID: &str = "s3_access_key_id";
pub const S3_SECRET_ACCESS_KEY: &str = "s3_secret_access_key";
pub const S3_CDN_URL: &str = "s3_cdn_url";
pub const S3_CDN_TOKEN_KEY: &str = "s3_cdn_token_key";

/// Resolved S3 connection config (all required fields present).
#[derive(Debug, Clone)]
pub struct S3Config {
    pub endpoint: String,
    pub region: String,
    pub bucket: String,
    pub access_key_id: String,
    pub secret_access_key: String,
}

/// Per-field overrides for resolving an S3 config. A non-empty value wins;
/// `None`/empty falls back to the saved setting. Used by "try now" so admins
/// can test unsaved form values without persisting them first.
#[derive(Debug, Default)]
pub struct S3Override {
    pub endpoint: Option<String>,
    pub region: Option<String>,
    pub bucket: Option<String>,
    pub access_key_id: Option<String>,
    pub secret_access_key: Option<String>,
}

/// Fetch a single setting. Returns `None` for missing or empty values.
pub async fn get(pool: &DbPool, key: &str) -> Option<String> {
    sqlx::query_scalar::<_, String>("SELECT value FROM app_settings WHERE key = $1")
        .bind(key)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .filter(|v| !v.trim().is_empty())
}

/// Upsert a single setting.
pub async fn set(pool: &DbPool, key: &str, value: &str) -> Result<(), sqlx::Error> {
    sqlx::query(
        "INSERT INTO app_settings (key, value, updated_at) VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    )
    .bind(key)
    .bind(value)
    .execute(pool)
    .await?;
    Ok(())
}

/// Resolve Azure embedding config as `(url, api_key)`. Errors if either is unset.
pub async fn embedding_config(pool: &DbPool) -> Result<(String, String), String> {
    embedding_config_with(pool, None, None).await
}

/// Like `embedding_config`, but lets a caller override the URL/key (used by the
/// Services "try now" check). A blank/`None` override falls back to the saved value.
pub async fn embedding_config_with(
    pool: &DbPool,
    url_ov: Option<String>,
    key_ov: Option<String>,
) -> Result<(String, String), String> {
    let url = resolve(pool, url_ov, AZURE_EMBEDDING_URL)
        .await
        .ok_or_else(|| "Embedding URL not configured (set it in Services settings)".to_string())?;
    let api_key = resolve(pool, key_ov, AZURE_EMBEDDING_API_KEY)
        .await
        .ok_or_else(|| "Embedding API key not configured (set it in Services settings)".to_string())?;
    Ok((url, api_key))
}

/// Resolve OpenClaw config as `(url, gateway_token)`. Errors if the URL is unset;
/// the token may be empty.
pub async fn openclaw_config(pool: &DbPool) -> Result<(String, String), String> {
    openclaw_config_with(pool, None, None).await
}

/// Like `openclaw_config`, but lets a caller override the URL/token (used by the
/// Services "try now" check). A blank/`None` override falls back to the saved value.
pub async fn openclaw_config_with(
    pool: &DbPool,
    url_ov: Option<String>,
    token_ov: Option<String>,
) -> Result<(String, String), String> {
    let url = resolve(pool, url_ov, OPENCLAW_URL)
        .await
        .ok_or_else(|| "OpenClaw URL not configured (set it in Services settings)".to_string())?;
    let token = resolve(pool, token_ov, OPENCLAW_GATEWAY_TOKEN)
        .await
        .unwrap_or_default();
    Ok((url, token))
}

/// Resolve the S3 connection config from saved settings. Errors if any required
/// field is unset.
pub async fn s3_config(pool: &DbPool) -> Result<S3Config, String> {
    s3_config_with(pool, S3Override::default()).await
}

/// Pick an override value (trimmed, non-empty) or fall back to the saved setting.
async fn resolve(pool: &DbPool, ov: Option<String>, key: &str) -> Option<String> {
    match ov {
        Some(v) if !v.trim().is_empty() => Some(v.trim().to_string()),
        _ => get(pool, key).await,
    }
}

/// Resolve the S3 connection config, letting `ov` override individual fields.
/// Errors if any required field is unset. Region falls back to `us-east-1`
/// (ignored by most S3-compatible gateways).
pub async fn s3_config_with(pool: &DbPool, ov: S3Override) -> Result<S3Config, String> {
    let missing = |what: &str| format!("S3 {what} not configured (set it in Services settings)");
    let endpoint = resolve(pool, ov.endpoint, S3_ENDPOINT)
        .await
        .ok_or_else(|| missing("endpoint"))?;
    let bucket = resolve(pool, ov.bucket, S3_BUCKET)
        .await
        .ok_or_else(|| missing("bucket"))?;
    let access_key_id = resolve(pool, ov.access_key_id, S3_ACCESS_KEY_ID)
        .await
        .ok_or_else(|| missing("access key ID"))?;
    let secret_access_key = resolve(pool, ov.secret_access_key, S3_SECRET_ACCESS_KEY)
        .await
        .ok_or_else(|| missing("secret access key"))?;
    let region = resolve(pool, ov.region, S3_REGION)
        .await
        .unwrap_or_else(|| "us-east-1".to_string());
    Ok(S3Config {
        endpoint,
        region,
        bucket,
        access_key_id,
        secret_access_key,
    })
}

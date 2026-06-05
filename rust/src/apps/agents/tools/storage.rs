//! Storage tools (read-only) — list objects under a prefix and mint a temporary
//! signed download URL. Reuses the storage handler's S3 helpers; write/delete
//! storage tools are Tier 3 and not wired in yet.

use serde_json::{json, Value};

use super::*;
use crate::apps::storage::handlers::{download_url, is_dir_marker, normalize_folder, s3_client};
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_storage",
            "List files and folders under a storage prefix (Bunny object storage).",
            json!({
                "type": "object",
                "properties": { "prefix": { "type": "string", "description": "folder prefix, e.g. docs/ (default root)" } }
            }),
        ),
        (
            "signed_url",
            "Mint a temporary signed download URL for a stored file key.",
            json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "object key" },
                    "expires_in_secs": { "type": "integer", "description": "URL lifetime in seconds (default 3600)" }
                },
                "required": ["key"]
            }),
        ),
    ]
}

pub async fn list_storage(pool: &DbPool, _user_id: &str, args: &Value) -> Result<Value, String> {
    let prefix = normalize_folder(opt_string(args, "prefix").as_deref().unwrap_or(""));
    let (client, bucket) = s3_client(pool).await?;
    let out = client
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(&prefix)
        .delimiter("/")
        .max_keys(200)
        .send()
        .await
        .map_err(|e| format!("list failed: {e}"))?;

    let folders: Vec<String> = out
        .common_prefixes()
        .iter()
        .filter_map(|cp| cp.prefix().map(|s| s.to_string()))
        .collect();
    let files: Vec<Value> = out
        .contents()
        .iter()
        .filter(|o| {
            let k = o.key().unwrap_or("");
            !k.is_empty() && !k.ends_with('/') && k != prefix && !is_dir_marker(o)
        })
        .map(|o| json!({ "key": o.key().unwrap_or(""), "size": o.size().unwrap_or(0) }))
        .collect();
    Ok(json!({ "prefix": prefix, "folders": folders, "files": files }))
}

pub async fn signed_url(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let key = req_str(args, "key")?;
    let expires_in = args
        .get("expires_in_secs")
        .and_then(|v| v.as_i64())
        .unwrap_or(3600)
        .clamp(60, 86_400);
    let (client, bucket) = s3_client(pool).await?;
    let (url, expires_at) = download_url(pool, &client, &bucket, &key, expires_in).await?;
    Ok(json!({ "url": url, "expires_at": expires_at }))
}

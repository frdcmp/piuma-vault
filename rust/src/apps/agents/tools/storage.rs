//! Storage tools (read-only) — list objects under a prefix and mint a temporary
//! signed download URL. Reuses the storage handler's S3 helpers; write/delete
//! storage tools are Tier 3 and not wired in yet.

use std::time::Duration;

use aws_sdk_s3::presigning::PresigningConfig;
use serde_json::{json, Value};

use super::*;
use crate::apps::storage::handlers::{
    collect_objects_under_prefix, download_url, is_dir_marker, normalize_folder, prune_empty_parents,
    public_base, s3_client, zip_to_signed_url,
};
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
        (
            "delete_object",
            "Delete a single stored file by key. Confirm with the user first — not recoverable.",
            json!({
                "type": "object",
                "properties": { "key": { "type": "string", "description": "object key" } },
                "required": ["key"]
            }),
        ),
        (
            "delete_folder",
            "Delete every object under a storage prefix (folder). Confirm first — not recoverable.",
            json!({
                "type": "object",
                "properties": { "prefix": { "type": "string", "description": "folder prefix, e.g. docs/" } },
                "required": ["prefix"]
            }),
        ),
        (
            "bulk_move",
            "Move/rename objects: copy each source key to its destination, then delete the source.",
            json!({
                "type": "object",
                "properties": {
                    "items": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "from": { "type": "string" },
                                "to": { "type": "string" }
                            },
                            "required": ["from", "to"]
                        }
                    }
                },
                "required": ["items"]
            }),
        ),
        (
            "presign_upload",
            "Issue a short-lived presigned PUT URL so a file can be uploaded directly to storage.",
            json!({
                "type": "object",
                "properties": {
                    "key": { "type": "string", "description": "destination object key" },
                    "content_type": { "type": "string" },
                    "expires_in_secs": { "type": "integer", "description": "URL lifetime (default 900, max 3600)" }
                },
                "required": ["key"]
            }),
        ),
        (
            "zip_bundle",
            "Bundle files and/or folders into a zip and return a temporary signed download URL.",
            json!({
                "type": "object",
                "properties": {
                    "keys": { "type": "array", "items": { "type": "string" }, "description": "explicit object keys" },
                    "prefixes": { "type": "array", "items": { "type": "string" }, "description": "folder prefixes to include" },
                    "filename": { "type": "string", "description": "zip file name (optional)" }
                }
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

pub async fn delete_object(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let key = req_str(args, "key")?;
    let key = key.trim_start_matches('/').to_string();
    if key.is_empty() || key.ends_with('/') {
        return Err("invalid key".into());
    }
    let (client, bucket) = s3_client(pool).await?;
    client
        .delete_object()
        .bucket(&bucket)
        .key(&key)
        .send()
        .await
        .map_err(|e| format!("delete failed: {e}"))?;
    prune_empty_parents(&client, &bucket, &key).await;
    Ok(json!({ "key": key, "deleted": true }))
}

pub async fn delete_folder(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let prefix = normalize_folder(&req_str(args, "prefix")?);
    if prefix.is_empty() {
        return Err("refusing to delete the storage root".into());
    }
    let (client, bucket) = s3_client(pool).await?;
    let objects = collect_objects_under_prefix(&client, &bucket, &prefix).await?;
    let mut deleted = 0u32;
    for (key, is_dir) in objects {
        let target = if is_dir && !key.ends_with('/') {
            format!("{key}/")
        } else {
            key
        };
        match client.delete_object().bucket(&bucket).key(&target).send().await {
            Ok(_) => deleted += 1,
            Err(e) => log::warn!("agent delete_folder: {target}: {e}"),
        }
    }
    // Drop the folder's own marker and prune now-empty ancestors.
    let _ = client.delete_object().bucket(&bucket).key(&prefix).send().await;
    prune_empty_parents(&client, &bucket, &prefix).await;
    Ok(json!({ "prefix": prefix, "deleted_count": deleted }))
}

pub async fn bulk_move(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let items = args
        .get("items")
        .and_then(|v| v.as_array())
        .ok_or("`items` array is required")?;
    let (client, bucket) = s3_client(pool).await?;
    let mut moved = Vec::new();
    let mut failed = Vec::new();
    for item in items {
        let from = item.get("from").and_then(|v| v.as_str()).unwrap_or("");
        let to = item.get("to").and_then(|v| v.as_str()).unwrap_or("");
        if from.is_empty() || to.is_empty() {
            failed.push(json!({ "from": from, "to": to, "error": "from/to required" }));
            continue;
        }
        let copy_source = format!("{bucket}/{}", urlencoding::encode(from));
        match client
            .copy_object()
            .bucket(&bucket)
            .key(to)
            .copy_source(&copy_source)
            .send()
            .await
        {
            Ok(_) => match client.delete_object().bucket(&bucket).key(from).send().await {
                Ok(_) => {
                    prune_empty_parents(&client, &bucket, from).await;
                    moved.push(json!({ "from": from, "to": to }));
                }
                Err(e) => failed.push(json!({ "from": from, "to": to, "error": format!("delete source: {e}") })),
            },
            Err(e) => failed.push(json!({ "from": from, "to": to, "error": format!("copy: {e}") })),
        }
    }
    Ok(json!({ "moved": moved, "failed": failed }))
}

pub async fn presign_upload(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let key = req_str(args, "key")?;
    let key = key.trim_start_matches('/').to_string();
    if key.is_empty() || key.ends_with('/') {
        return Err("invalid key".into());
    }
    let expires = args
        .get("expires_in_secs")
        .and_then(|v| v.as_i64())
        .unwrap_or(900)
        .clamp(1, 3600) as u64;
    let (client, bucket) = s3_client(pool).await?;
    let cfg = PresigningConfig::expires_in(Duration::from_secs(expires))
        .map_err(|e| format!("presign config: {e}"))?;
    let mut req = client.put_object().bucket(&bucket).key(&key);
    if let Some(ct) = opt_string(args, "content_type").filter(|s| !s.is_empty()) {
        req = req.content_type(ct);
    }
    let base = public_base(pool).await;
    let public_url = if base.is_empty() {
        String::new()
    } else {
        format!("{base}/{key}")
    };
    let presigned = req.presigned(cfg).await.map_err(|e| format!("presign failed: {e}"))?;
    Ok(json!({ "url": presigned.uri().to_string(), "key": key, "public_url": public_url }))
}

pub async fn zip_bundle(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let keys = opt_str_array(args, "keys").unwrap_or_default();
    let prefixes = opt_str_array(args, "prefixes").unwrap_or_default();
    if keys.is_empty() && prefixes.is_empty() {
        return Err("provide at least one key or prefix".into());
    }
    let filename = opt_string(args, "filename");
    let (client, bucket) = s3_client(pool).await?;
    let (url, name) = zip_to_signed_url(pool, &client, &bucket, keys, prefixes, filename).await?;
    Ok(json!({ "url": url, "filename": name }))
}

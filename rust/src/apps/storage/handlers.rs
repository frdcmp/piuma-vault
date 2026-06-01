use actix_web::{web, HttpResponse, Responder};
use aws_sdk_s3::{
    config::{BehaviorVersion, Credentials, Region},
    presigning::PresigningConfig,
    primitives::ByteStream,
    Client,
};
use std::io::{Cursor, Write};
use std::time::Duration;
use zip::{write::SimpleFileOptions, CompressionMethod, ZipWriter};

use super::models::{
    ApiMessage, BulkDeleteRequest, BulkMoveRequest, BulkMoveResponse, DeleteFailure,
    DeleteFolderRequest, DeleteResponse, ListQuery, ListResponse, MoveResult, ObjectEntry,
    PresignUploadRequest, PresignUploadResponse, SignedUrlRequest, SignedUrlResponse,
    ZipBundleRequest, ZipBundleResponse,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use sha2::{Digest, Sha256};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::settings::store;
use crate::db::db::DbPool;

// Permission gate. A dedicated scoped permission so least-privilege API keys can
// be granted storage access without handing over the whole admin panel.
// `check_permission` also treats `admin_access` as a superset, so admin JWTs and
// admin keys keep working unchanged.
const REQUIRED_PERM: &str = "storage.access";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(ApiMessage {
        message: format!("Insufficient permissions. Required: {REQUIRED_PERM}"),
    })
}

fn err(status: actix_web::http::StatusCode, msg: impl Into<String>) -> HttpResponse {
    HttpResponse::build(status).json(ApiMessage { message: msg.into() })
}

// Normalizes a folder path to "a/b/" (no leading slash, single trailing slash,
// empty for root). Keeps the S3 key shape consistent regardless of how the
// client formats the input.
fn normalize_folder(input: &str) -> String {
    let trimmed = input.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{trimmed}/")
    }
}

// True if a listed object is one of Bunny's folder markers rather than a real
// file. Bunny stores directories as zero-byte objects with an empty ETag (the
// Checksum is blank for directories); real files always carry a checksum, even
// empty ones. This is the single source of truth for telling folders from files.
// Internal folder used to stage generated zip archives so they can be served
// directly from the CDN. Hidden from listings.
const TEMP_PREFIX: &str = "__temp/";

// Optional CDN base URL (no trailing slash); empty string when unset. Used to
// build public/object URLs where a missing CDN is not an error.
async fn cdn_base(pool: &DbPool) -> String {
    store::get(pool, store::S3_CDN_URL)
        .await
        .map(|v| v.trim_end_matches('/').to_string())
        .unwrap_or_default()
}

// Base URL for tokenless object links: the CDN when configured, otherwise the
// direct S3 endpoint/bucket path (`{endpoint}/{bucket}`). The CDN is an optional
// accelerator — S3-only setups fall back to the bucket's own public URL (which
// requires the bucket/object to allow public reads). Empty only if S3 itself is
// unconfigured.
async fn public_base(pool: &DbPool) -> String {
    let cdn = cdn_base(pool).await;
    if !cdn.is_empty() {
        return cdn;
    }
    match store::s3_config(pool).await {
        Ok(cfg) => format!(
            "{}/{}",
            cfg.endpoint.trim_end_matches('/'),
            cfg.bucket.trim_matches('/')
        ),
        Err(_) => String::new(),
    }
}

// Builds a Bunny URL-Token-Auth signed CDN URL: token = URL-safe-base64 (no pad)
// of SHA-256(security_key + signed_path + expires), signed_path being the path
// under the pull zone starting with `/`.
fn sign_cdn_url(cdn_base: &str, security_key: &str, key: &str, expires_at: i64) -> String {
    let signed_path = format!("/{}", key.trim_start_matches('/'));
    let mut hasher = Sha256::new();
    hasher.update(security_key.as_bytes());
    hasher.update(signed_path.as_bytes());
    hasher.update(expires_at.to_string().as_bytes());
    let token = URL_SAFE_NO_PAD.encode(hasher.finalize());
    format!("{cdn_base}{signed_path}?token={token}&expires={expires_at}")
}

// Time-limited URL to fetch an object directly from the client. Uses a signed
// CDN URL when a CDN is configured; otherwise falls back to an S3 presigned GET
// (works on private buckets, no CDN required). Returns `(url, expires_at)`.
async fn download_url(
    pool: &DbPool,
    client: &Client,
    bucket: &str,
    key: &str,
    expires_in: i64,
) -> Result<(String, i64), String> {
    let expires_at = chrono::Utc::now().timestamp() + expires_in;
    let cdn = cdn_base(pool).await;
    if !cdn.is_empty() {
        // CDN configured. Sign with token-auth when a key is set; otherwise serve
        // a plain public CDN URL (token key is optional — for public pull zones).
        return Ok(match store::get(pool, store::S3_CDN_TOKEN_KEY).await {
            Some(token) => (sign_cdn_url(&cdn, &token, key, expires_at), expires_at),
            None => (format!("{cdn}/{}", key.trim_start_matches('/')), expires_at),
        });
    }
    // S3-only fallback. SigV4 presigning caps expiry at 7 days; clamp so a long
    // CDN-style expiry doesn't make the presign call fail outright.
    let secs = expires_in.clamp(1, 7 * 24 * 60 * 60) as u64;
    let cfg = PresigningConfig::expires_in(Duration::from_secs(secs))
        .map_err(|e| format!("presign config: {e}"))?;
    let presigned = client
        .get_object()
        .bucket(bucket)
        .key(key)
        .presigned(cfg)
        .await
        .map_err(|e| format!("presign failed: {e}"))?;
    Ok((presigned.uri().to_string(), chrono::Utc::now().timestamp() + secs as i64))
}

fn is_dir_marker(o: &aws_sdk_s3::types::Object) -> bool {
    let etag_blank = o
        .e_tag()
        .map(|e| e.trim_matches('"').is_empty())
        .unwrap_or(true);
    o.size().unwrap_or(0) == 0 && etag_blank
}

// Builds an S3 client + bucket name from the saved S3 settings (Services
// dashboard). Works with any S3-compatible endpoint (AWS S3, Bunny, R2, MinIO,
// …); path-style URLs keep the widest compatibility.
async fn s3_client(pool: &DbPool) -> Result<(Client, String), String> {
    Ok(client_from(store::s3_config(pool).await?))
}

// Builds the aws-sdk-s3 client + bucket name from a resolved config.
fn client_from(cfg: crate::apps::settings::store::S3Config) -> (Client, String) {
    let creds = Credentials::new(
        cfg.access_key_id,
        cfg.secret_access_key,
        None,
        None,
        "s3-static",
    );
    let conf = aws_sdk_s3::config::Builder::new()
        .behavior_version(BehaviorVersion::latest())
        .region(Region::new(cfg.region))
        .credentials_provider(creds)
        .endpoint_url(cfg.endpoint)
        .force_path_style(true)
        .build();
    (Client::from_conf(conf), cfg.bucket)
}

// Live connectivity check for the Services dashboard. Two separate validations:
//   1. Storage — list the bucket (proves credentials + endpoint).
//   2. CDN — only when configured: fetch a real object through the CDN URL to
//      prove delivery. Skipped (and not an error) when no CDN is set.
// `overrides` carry unsaved storage form values; `cdn_url`/`cdn_token` carry the
// unsaved CDN form values so the whole panel can be tested before saving.
pub async fn test_connection(
    pool: &DbPool,
    overrides: store::S3Override,
    cdn_url: Option<String>,
    cdn_token: Option<String>,
) -> Result<String, String> {
    let (client, bucket) = client_from(store::s3_config_with(pool, overrides).await?);

    // 1) Storage. List a handful so we also have a sample key for the CDN check.
    let out = client
        .list_objects_v2()
        .bucket(&bucket)
        .max_keys(50)
        .send()
        .await
        .map_err(|e| format!("list failed: {e}"))?;
    let storage_msg = format!("bucket '{bucket}' reachable");

    // 2) CDN (optional). Prefer the unsaved form value, else the saved setting.
    let cdn = match cdn_url
        .map(|v| v.trim().trim_end_matches('/').to_string())
        .filter(|v| !v.is_empty())
    {
        Some(v) => v,
        None => cdn_base(pool).await,
    };
    if cdn.is_empty() {
        return Ok(format!("OK — {storage_msg}"));
    }
    let token = match cdn_token.map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
        Some(v) => Some(v),
        None => store::get(pool, store::S3_CDN_TOKEN_KEY).await,
    };

    // Need a real object to fetch through the CDN.
    let sample = out
        .contents()
        .iter()
        .filter(|o| !is_dir_marker(o))
        .filter_map(|o| o.key())
        .find(|k| !k.ends_with('/'))
        .map(|s| s.to_string());
    let Some(key) = sample else {
        return Ok(format!(
            "OK — {storage_msg} · CDN set (bucket empty — no object to verify delivery)"
        ));
    };

    let expires_at = chrono::Utc::now().timestamp() + 60;
    let url = match &token {
        Some(t) => sign_cdn_url(&cdn, t, &key, expires_at),
        None => format!("{cdn}/{}", key.trim_start_matches('/')),
    };
    match reqwest::Client::new()
        .get(&url)
        .timeout(Duration::from_secs(8))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => Ok(format!(
            "OK — {storage_msg} · CDN delivering (HTTP {})",
            r.status().as_u16()
        )),
        Ok(r) => Err(format!(
            "Storage OK ({storage_msg}); CDN returned HTTP {}",
            r.status().as_u16()
        )),
        Err(e) => Err(format!("Storage OK ({storage_msg}); CDN unreachable: {e}")),
    }
}

pub async fn hello() -> impl Responder {
    HttpResponse::Ok().json(ApiMessage {
        message: "Bunny Storage API — Ready".to_string(),
    })
}

// GET /storage/list — paginated list of objects under a prefix, with folder
// collapsing via delimiter (default `/`).
pub async fn list(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<ListQuery>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let prefix = normalize_folder(q.prefix.as_deref().unwrap_or(""));
    let delimiter = q.delimiter.clone().unwrap_or_else(|| "/".into());
    let max_keys = q.max_keys.unwrap_or(1000).clamp(1, 1000);

    let mut req = client
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(&prefix)
        .delimiter(&delimiter)
        .max_keys(max_keys);
    if let Some(token) = q.continuation_token.as_ref() {
        req = req.continuation_token(token);
    }

    match req.send().await {
        Ok(out) => {
            // Folders the gateway collapsed under the delimiter, e.g. "docs/".
            let mut folder_set: std::collections::BTreeSet<String> = out
                .common_prefixes()
                .iter()
                .filter_map(|cp| cp.prefix().map(|s| s.to_string()))
                .collect();
            // Bunny represents every folder as a zero-byte object with an EMPTY
            // ETag (its Checksum field is blank for directories). A folder with
            // children also shows up as a common prefix, but an *empty* folder
            // only appears here in Contents — so without this it would render as
            // a phantom 0-byte file. Surface such markers as folders instead.
            for o in out.contents() {
                let k = o.key().unwrap_or("");
                if k.is_empty() || k == prefix {
                    continue;
                }
                if is_dir_marker(o) {
                    let folder = if k.ends_with('/') {
                        k.to_string()
                    } else {
                        format!("{k}/")
                    };
                    folder_set.insert(folder);
                }
            }
            // Hide the internal zip-staging folder from clients.
            let folders: Vec<String> =
                folder_set.into_iter().filter(|f| f != TEMP_PREFIX).collect();
            let files: Vec<ObjectEntry> = out
                .contents()
                .iter()
                // Drop folder markers: keys ending in "/", the listed prefix
                // itself, and Bunny's zero-byte/empty-ETag directory objects.
                .filter(|o| {
                    let k = o.key().unwrap_or("");
                    !k.is_empty() && !k.ends_with('/') && k != prefix && !is_dir_marker(o)
                })
                .map(|o| ObjectEntry {
                    key: o.key().unwrap_or("").to_string(),
                    size: o.size().unwrap_or(0),
                    last_modified: o.last_modified().map(|d| d.to_string()),
                    etag: o.e_tag().map(|s| s.to_string()),
                })
                .collect();
            let cdn_base = public_base(pool.get_ref()).await;
            HttpResponse::Ok().json(ListResponse {
                prefix,
                delimiter: Some(delimiter),
                folders,
                files,
                continuation_token: out.next_continuation_token().map(|s| s.to_string()),
                is_truncated: out.is_truncated().unwrap_or(false),
                cdn_base,
            })
        }
        Err(e) => err(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("list failed: {e}"),
        ),
    }
}

// POST /storage/presign-upload — issue a short-lived presigned PUT URL so the
// browser/app uploads the file bytes DIRECTLY to Bunny. The file never passes
// through this backend; only the signed URL crosses the client↔backend boundary.
// The client must PUT to `url` with the same `Content-Type` it sent here.
pub async fn presign_upload(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<PresignUploadRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let key = body.key.trim_start_matches('/').to_string();
    if key.is_empty() || key.ends_with('/') {
        return err(actix_web::http::StatusCode::BAD_REQUEST, "invalid key");
    }
    let expires = body.expires_in_secs.unwrap_or(900).clamp(1, 3600);
    let cfg = match PresigningConfig::expires_in(Duration::from_secs(expires)) {
        Ok(c) => c,
        Err(e) => {
            return err(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("presign config: {e}"),
            )
        }
    };

    let mut req = client.put_object().bucket(&bucket).key(&key);
    if let Some(ct) = body.content_type.as_ref().filter(|s| !s.is_empty()) {
        req = req.content_type(ct);
    }
    let base = public_base(pool.get_ref()).await;
    let public_url = if base.is_empty() {
        String::new()
    } else {
        format!("{base}/{key}")
    };
    match req.presigned(cfg).await {
        Ok(p) => HttpResponse::Ok().json(PresignUploadResponse {
            url: p.uri().to_string(),
            key,
            public_url,
        }),
        Err(e) => err(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("presign failed: {e}"),
        ),
    }
}

// DELETE /storage/object/{key} — single object delete.
pub async fn delete_object(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<String>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let key = path.into_inner();

    match client.delete_object().bucket(&bucket).key(&key).send().await {
        Ok(_) => {
            // Drop the folder marker if this was the last file in it.
            prune_empty_parents(&client, &bucket, &key).await;
            HttpResponse::Ok().json(DeleteResponse {
                deleted: vec![key],
                failed: vec![],
            })
        }
        Err(e) => err(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("delete failed: {e}"),
        ),
    }
}

// Lists every object under a prefix, paginating through all pages, returning
// each key paired with whether it is a Bunny directory marker. Used for
// recursive folder operations (delete-folder, zip-by-prefix).
async fn collect_objects_under_prefix(
    client: &Client,
    bucket: &str,
    prefix: &str,
) -> Result<Vec<(String, bool)>, String> {
    let mut objects = Vec::new();
    let mut token: Option<String> = None;
    loop {
        let mut req = client.list_objects_v2().bucket(bucket).prefix(prefix);
        if let Some(t) = &token {
            req = req.continuation_token(t);
        }
        let out = req
            .send()
            .await
            .map_err(|e| format!("list under prefix failed: {e}"))?;
        for o in out.contents() {
            if let Some(k) = o.key() {
                objects.push((k.to_string(), is_dir_marker(o)));
            }
        }
        if out.is_truncated().unwrap_or(false) {
            token = out.next_continuation_token().map(|s| s.to_string());
            if token.is_none() {
                break;
            }
        } else {
            break;
        }
    }
    Ok(objects)
}

// Climbs the ancestry of a just-deleted key and removes any directory marker
// whose folder is now empty, so emptied folders disappear instead of lingering
// (Bunny keeps zero-byte directory objects around after their last file goes).
// A folder marker is addressed by its trailing-slash key (e.g. "docs/"), which
// is the only form Bunny's S3 gateway will actually delete. Stops at the first
// ancestor that still holds a file or subfolder.
async fn prune_empty_parents(client: &Client, bucket: &str, key: &str) {
    let mut cur = key.trim_end_matches('/').to_string();
    while let Some(idx) = cur.rfind('/') {
        let parent = cur[..=idx].to_string(); // includes the trailing slash
        let out = match client
            .list_objects_v2()
            .bucket(bucket)
            .prefix(&parent)
            .delimiter("/")
            .max_keys(2)
            .send()
            .await
        {
            Ok(o) => o,
            Err(_) => return,
        };
        // Any remaining child (file or nested marker) or subfolder keeps the
        // folder alive. The parent's own marker has no trailing slash, so it
        // never appears under this prefix and can't be mistaken for content.
        let occupied = out.contents().iter().any(|o| {
            let k = o.key().unwrap_or("");
            !k.is_empty() && k != parent
        }) || !out.common_prefixes().is_empty();
        if occupied {
            return;
        }
        let _ = client
            .delete_object()
            .bucket(bucket)
            .key(&parent)
            .send()
            .await;
        cur = parent.trim_end_matches('/').to_string();
    }
}

// DELETE /storage/folder — recursive delete of everything under a prefix
// (plus the empty marker object itself). Delegates to the bulk-delete helper.
pub async fn delete_folder(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<DeleteFolderRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let prefix = normalize_folder(&body.path);
    if prefix.is_empty() {
        return err(
            actix_web::http::StatusCode::BAD_REQUEST,
            "refusing to delete root",
        );
    }
    let objects = match collect_objects_under_prefix(&client, &bucket, &prefix).await {
        Ok(o) => o,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    // Build the delete list. Nested directory markers must be addressed by their
    // trailing-slash key (the only form Bunny's gateway honours); real files are
    // deleted as-is. Finally append the folder's own marker (`prefix`), which
    // sits at the no-slash key and isn't returned under this prefix listing.
    let mut keys: Vec<String> = objects
        .into_iter()
        .map(|(k, is_dir)| {
            if is_dir && !k.ends_with('/') {
                format!("{k}/")
            } else {
                k
            }
        })
        .collect();
    keys.push(prefix.clone());
    let resp = delete_keys_individually(&client, &bucket, keys).await;
    // The folder is gone; tidy up any now-empty ancestors too.
    prune_empty_parents(&client, &bucket, &prefix).await;
    resp
}

// POST /storage/bulk/delete — delete a list of keys. Bunny's S3 gateway does
// NOT implement the batch DeleteObjects API (it returns NotImplemented), so we
// delete each key with an individual request, then prune any folders left empty.
pub async fn bulk_delete(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<BulkDeleteRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let keys = body.into_inner().keys;
    // Dedup the keys' folders so each emptied folder is pruned just once.
    let parents: std::collections::BTreeSet<String> =
        keys.iter().filter(|k| k.contains('/')).cloned().collect();
    let resp = delete_keys_individually(&client, &bucket, keys).await;
    for parent in parents {
        prune_empty_parents(&client, &bucket, &parent).await;
    }
    resp
}

// Deletes each key with its own request (Bunny has no batch delete), reporting
// per-key success/failure. A delete that errors is recorded but doesn't abort
// the rest.
async fn delete_keys_individually(
    client: &Client,
    bucket: &str,
    keys: Vec<String>,
) -> HttpResponse {
    let mut deleted = Vec::new();
    let mut failed: Vec<DeleteFailure> = Vec::new();
    for key in keys {
        match client.delete_object().bucket(bucket).key(&key).send().await {
            Ok(_) => deleted.push(key),
            Err(e) => failed.push(DeleteFailure {
                key,
                error: format!("delete: {e}"),
            }),
        }
    }
    HttpResponse::Ok().json(DeleteResponse { deleted, failed })
}

// POST /storage/bulk/move — server-side copy + delete for each item.
// Returns per-item results; failures in copy skip the delete so the source
// remains intact and can be retried.
pub async fn bulk_move(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<BulkMoveRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    let mut results = Vec::with_capacity(body.items.len());
    for item in &body.items {
        // CopyObject's `copy_source` is bucket/key URL-encoded.
        let copy_source = format!(
            "{}/{}",
            bucket,
            urlencoding::encode(&item.from)
        );
        let copy_res = client
            .copy_object()
            .bucket(&bucket)
            .copy_source(&copy_source)
            .key(&item.to)
            .send()
            .await;
        let error = match copy_res {
            Ok(_) => match client
                .delete_object()
                .bucket(&bucket)
                .key(&item.from)
                .send()
                .await
            {
                Ok(_) => None,
                Err(e) => Some(format!("delete source: {e}")),
            },
            Err(e) => Some(format!("copy: {e}")),
        };
        results.push(MoveResult {
            from: item.from.clone(),
            to: item.to.clone(),
            error,
        });
    }
    HttpResponse::Ok().json(BulkMoveResponse { results })
}

// POST /storage/signed-url — issue a Bunny URL-Token-Auth signed CDN URL for a
// single object. Algorithm (per Bunny's docs): the URL token is the
// URL-safe-base64 (no padding) of SHA-256(security_key + signed_path + expires).
// The signed path is the URL path under the Pull Zone, starting with `/`.
// Returns `?token=…&expires=…` query-stringed CDN URL.
pub async fn signed_url(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<SignedUrlRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let key = body.key.trim_start_matches('/').to_string();
    if key.is_empty() {
        return err(actix_web::http::StatusCode::BAD_REQUEST, "key is empty");
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    let expires_in = body.expires_in_secs.unwrap_or(3600).clamp(1, 60 * 60 * 24 * 365);
    match download_url(pool.get_ref(), &client, &bucket, &key, expires_in).await {
        Ok((url, expires_at)) => HttpResponse::Ok().json(SignedUrlResponse { url, expires_at }),
        Err(e) => err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    }
}

// POST /storage/zip — build a zip archive of everything under `prefix` (and/or
// explicit `keys`) in memory, store it under the internal `__temp/` folder on
// Bunny, and return a signed CDN URL. The client downloads the archive directly
// from the CDN; the zip bytes never stream back through this backend.
pub async fn zip_bundle(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<ZipBundleRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };

    // Gather the target key list. Every prefix — the single `prefix` plus any in
    // `prefixes` — is expanded to its (non-marker) objects.
    let mut keys: Vec<String> = body.keys.clone();
    let prefixes = body
        .prefix
        .iter()
        .cloned()
        .chain(body.prefixes.iter().cloned())
        .collect::<Vec<_>>();
    for p in &prefixes {
        let prefix = normalize_folder(p);
        if prefix.is_empty() {
            continue;
        }
        match collect_objects_under_prefix(&client, &bucket, &prefix).await {
            // Skip directory markers — only real files go into the archive.
            Ok(more) => keys.extend(more.into_iter().filter(|(_, is_dir)| !is_dir).map(|(k, _)| k)),
            Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
        }
    }
    keys.sort();
    keys.dedup();
    let keys: Vec<String> = keys.into_iter().filter(|k| !k.ends_with('/')).collect();
    if keys.is_empty() {
        return err(actix_web::http::StatusCode::BAD_REQUEST, "nothing to bundle");
    }

    // Build the zip in memory. Each entry inside the archive is the full
    // object key, preserving the folder structure.
    let buf: Vec<u8> = Vec::new();
    let cursor = Cursor::new(buf);
    let mut zip = ZipWriter::new(cursor);
    let opts: SimpleFileOptions = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    for key in &keys {
        let obj = match client.get_object().bucket(&bucket).key(key).send().await {
            Ok(o) => o,
            Err(e) => {
                log::warn!("[storage/zip] skipping {key}: {e}");
                continue;
            }
        };
        let bytes = match obj.body.collect().await {
            Ok(b) => b.into_bytes(),
            Err(e) => {
                log::warn!("[storage/zip] body read failed for {key}: {e}");
                continue;
            }
        };
        if let Err(e) = zip.start_file::<_, ()>(key, opts) {
            log::warn!("[storage/zip] start_file failed for {key}: {e}");
            continue;
        }
        if let Err(e) = zip.write_all(&bytes) {
            log::warn!("[storage/zip] write failed for {key}: {e}");
            continue;
        }
    }

    let cursor = match zip.finish() {
        Ok(c) => c,
        Err(e) => {
            return err(
                actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
                format!("zip finalize: {e}"),
            )
        }
    };
    let zipped = cursor.into_inner();

    // Stage the archive in the internal __temp/ folder so it can be pulled
    // straight from the CDN. Name is sanitised; same folder name overwrites in
    // place so __temp doesn't grow without bound.
    let filename = body.filename.clone().unwrap_or_else(|| "bundle".into());
    let safe: String = filename
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() {
        "bundle".to_string()
    } else {
        safe
    };
    let temp_key = format!("{TEMP_PREFIX}{safe}.zip");

    if let Err(e) = client
        .put_object()
        .bucket(&bucket)
        .key(&temp_key)
        .body(ByteStream::from(zipped))
        .content_type("application/zip")
        .send()
        .await
    {
        return err(
            actix_web::http::StatusCode::INTERNAL_SERVER_ERROR,
            format!("store zip: {e}"),
        );
    }

    let url = match download_url(pool.get_ref(), &client, &bucket, &temp_key, 3600).await {
        Ok((url, _)) => url,
        Err(e) => return err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, e),
    };
    HttpResponse::Ok().json(ZipBundleResponse {
        url,
        key: temp_key,
    })
}

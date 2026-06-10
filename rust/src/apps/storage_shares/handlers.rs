use actix_web::{web, HttpResponse, Responder};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use aws_sdk_s3::primitives::ByteStream;
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::storage::handlers as st;
use crate::db::db::DbPool;

use super::models::{
    ApiError, CreateFolderShareRequest, CreateFolderShareResponse, FolderShare,
    FolderShareListItem, MoveBody, OkResponse, PathBody, PresignBody, PresignResponse,
    PublicFile, PublicListQuery, PublicListResponse, PublicShareMeta, PwdQuery, UpdateFolderShareRequest,
    UrlResponse, ZipBody,
};

const REQUIRED_PERM: &str = "storage.access";

fn err(status: actix_web::http::StatusCode, msg: impl Into<String>) -> HttpResponse {
    HttpResponse::build(status).json(ApiError { error: msg.into() })
}

fn bad(msg: impl Into<String>) -> HttpResponse {
    err(actix_web::http::StatusCode::BAD_REQUEST, msg)
}

fn ise(msg: impl Into<String>) -> HttpResponse {
    err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, msg)
}

// ── Crypto / slug helpers (mirrors the note-share implementation) ──

fn generate_slug(len: usize) -> String {
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    let mut rng = rand::thread_rng();
    (0..len)
        .map(|_| CHARS[rng.gen_range(0..CHARS.len())] as char)
        .collect()
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        Params::new(19456, 2, 1, None).map_err(|e| format!("argon2 params: {e}"))?,
    );
    Ok(argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("argon2 hash: {e}"))?
        .to_string())
}

fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash)
        .map(|parsed| Argon2::default().verify_password(password.as_bytes(), &parsed).is_ok())
        .unwrap_or(false)
}

fn share_url(slug: &str) -> String {
    let base = std::env::var("BASE_URL").unwrap_or_else(|_| "/".to_string());
    let base = if base.ends_with('/') { base } else { format!("{base}/") };
    format!("{base}s/{slug}")
}

// ── Public-access helpers ──

async fn fetch_share(pool: &DbPool, slug: &str) -> Result<FolderShare, HttpResponse> {
    let share = sqlx::query_as::<_, FolderShare>(
        "SELECT id, prefix, slug, access_level, password_hash, is_active, expires_at, max_upload_bytes, created_by, created_at, last_accessed_at
         FROM db_folder_shares WHERE slug = $1",
    )
    .bind(slug)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        log::error!("fetch folder share: {e}");
        ise("Failed to load share")
    })?;

    let share = share.ok_or_else(|| err(actix_web::http::StatusCode::NOT_FOUND, "Share not found"))?;

    if !share.is_active {
        return Err(err(
            actix_web::http::StatusCode::FORBIDDEN,
            "Share link has been deactivated",
        ));
    }
    if let Some(exp) = share.expires_at {
        if exp < Utc::now() {
            return Err(err(
                actix_web::http::StatusCode::FORBIDDEN,
                "Share link has expired",
            ));
        }
    }
    Ok(share)
}

fn check_pwd(share: &FolderShare, pwd: Option<&str>) -> Option<HttpResponse> {
    if let Some(hash) = &share.password_hash {
        match pwd {
            Some(p) if verify_password(p, hash) => None,
            Some(_) => Some(err(
                actix_web::http::StatusCode::UNAUTHORIZED,
                "Wrong password",
            )),
            None => Some(err(
                actix_web::http::StatusCode::UNAUTHORIZED,
                "Password required",
            )),
        }
    } else {
        None
    }
}

fn require_edit(share: &FolderShare) -> Option<HttpResponse> {
    if share.access_level != "edit" {
        Some(err(
            actix_web::http::StatusCode::FORBIDDEN,
            "This link is view-only",
        ))
    } else {
        None
    }
}

// Resolve a client-supplied RELATIVE path to an absolute object key inside the
// share. Rejects traversal. `as_dir` appends/normalizes a trailing slash.
fn resolve(prefix: &str, rel: &str, as_dir: bool) -> Result<String, HttpResponse> {
    let rel = rel.trim().trim_start_matches('/');
    if rel.split('/').any(|seg| seg == ".." || seg == ".") {
        return Err(bad("invalid path"));
    }
    let abs = if as_dir {
        st::normalize_folder(&format!("{prefix}{rel}"))
    } else {
        if rel.is_empty() || rel.ends_with('/') {
            return Err(bad("invalid file path"));
        }
        format!("{prefix}{rel}")
    };
    // Containment: the resolved key must stay within the share root.
    if !abs.starts_with(prefix) {
        return Err(err(actix_web::http::StatusCode::FORBIDDEN, "outside share"));
    }
    Ok(abs)
}

fn leaf_name(prefix: &str) -> String {
    prefix.trim_end_matches('/').rsplit('/').next().unwrap_or("share").to_string()
}

async fn touch(pool: &DbPool, id: Uuid) {
    let _ = sqlx::query("UPDATE db_folder_shares SET last_accessed_at = NOW() WHERE id = $1")
        .bind(id)
        .execute(pool)
        .await;
}

// ════════════════════════════════════════════════════════════════
// Public endpoints (slug-based, no auth)
// ════════════════════════════════════════════════════════════════

// GET /share/f/{slug}
pub async fn meta(pool: web::Data<DbPool>, path: web::Path<String>) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    touch(pool.get_ref(), share.id).await;
    HttpResponse::Ok().json(PublicShareMeta {
        slug: share.slug.clone(),
        can_edit: share.access_level == "edit",
        requires_password: share.password_hash.is_some(),
        expires_at: share.expires_at,
        root_name: leaf_name(&share.prefix),
        access_level: share.access_level,
    })
}

// GET /share/f/{slug}/list?path=&pwd=
pub async fn list(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PublicListQuery>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    let rel = q.path.clone().unwrap_or_default();
    let list_prefix = match resolve(&share.prefix, &rel, true) {
        Ok(p) => p,
        Err(r) => return r,
    };
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };

    let mut req = client
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(&list_prefix)
        .delimiter("/")
        .max_keys(1000);
    let mut folders: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    let mut files: Vec<PublicFile> = Vec::new();
    loop {
        let out = match req.clone().send().await {
            Ok(o) => o,
            Err(e) => return ise(format!("list failed: {e}")),
        };
        for cp in out.common_prefixes() {
            if let Some(p) = cp.prefix() {
                folders.insert(p.to_string());
            }
        }
        for o in out.contents() {
            let k = o.key().unwrap_or("");
            if k.is_empty() || k == list_prefix {
                continue;
            }
            if st::is_dir_marker(o) {
                folders.insert(if k.ends_with('/') { k.to_string() } else { format!("{k}/") });
            } else {
                files.push(PublicFile {
                    name: k.rsplit('/').next().unwrap_or(k).to_string(),
                    key: k[share.prefix.len()..].to_string(),
                    size: o.size().unwrap_or(0),
                    last_modified: o.last_modified().map(|d| d.to_string()),
                });
            }
        }
        if out.is_truncated().unwrap_or(false) {
            if let Some(t) = out.next_continuation_token() {
                req = client
                    .list_objects_v2()
                    .bucket(&bucket)
                    .prefix(&list_prefix)
                    .delimiter("/")
                    .max_keys(1000)
                    .continuation_token(t);
                continue;
            }
        }
        break;
    }

    // Strip the share root to relative paths; hide the internal staging folder.
    let rel_folders: Vec<String> = folders
        .into_iter()
        .filter(|f| *f != st::TEMP_PREFIX && f.len() > share.prefix.len())
        .map(|f| f[share.prefix.len()..].to_string())
        .collect();

    touch(pool.get_ref(), share.id).await;
    HttpResponse::Ok().json(PublicListResponse {
        path: list_prefix[share.prefix.len()..].to_string(),
        folders: rel_folders,
        files,
    })
}

// POST /share/f/{slug}/signed-url  { path }   (+ ?pwd=)
pub async fn signed_url(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<PathBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    let key = match resolve(&share.prefix, &body.path, false) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };
    match st::download_url(pool.get_ref(), &client, &bucket, &key, 300).await {
        Ok((url, _)) => HttpResponse::Ok().json(UrlResponse { url }),
        Err(e) => ise(e),
    }
}

// POST /share/f/{slug}/zip  { path? }  (+ ?pwd=)
pub async fn zip(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<ZipBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    let dir = match resolve(&share.prefix, body.path.as_deref().unwrap_or(""), true) {
        Ok(d) => d,
        Err(r) => return r,
    };
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };
    match st::zip_to_signed_url(
        pool.get_ref(),
        &client,
        &bucket,
        vec![],
        vec![dir.clone()],
        Some(leaf_name(&dir)),
    )
    .await
    {
        Ok((url, _)) => HttpResponse::Ok().json(UrlResponse { url }),
        Err(e) if e == "nothing to bundle" => bad(e),
        Err(e) => ise(e),
    }
}

// POST /share/f/{slug}/upload  { path, content_type? }  (+ ?pwd=)   [edit]
pub async fn presign_upload(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<PresignBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    if let Some(r) = require_edit(&share) {
        return r;
    }
    let key = match resolve(&share.prefix, &body.path, false) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };
    let cfg = match aws_sdk_s3::presigning::PresigningConfig::expires_in(std::time::Duration::from_secs(900)) {
        Ok(c) => c,
        Err(e) => return ise(format!("presign config: {e}")),
    };
    let mut req = client.put_object().bucket(&bucket).key(&key);
    if let Some(ct) = body.content_type.as_ref().filter(|s| !s.is_empty()) {
        req = req.content_type(ct);
    }
    match req.presigned(cfg).await {
        Ok(p) => HttpResponse::Ok().json(PresignResponse {
            url: p.uri().to_string(),
            key: key[share.prefix.len()..].to_string(),
        }),
        Err(e) => ise(format!("presign failed: {e}")),
    }
}

// DELETE /share/f/{slug}/object  { path }  (+ ?pwd=)   [edit]
pub async fn delete_object(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<PathBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    if let Some(r) = require_edit(&share) {
        return r;
    }
    let key = match resolve(&share.prefix, &body.path, false) {
        Ok(k) => k,
        Err(r) => return r,
    };
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };
    match client.delete_object().bucket(&bucket).key(&key).send().await {
        Ok(_) => {
            st::prune_empty_parents(&client, &bucket, &key).await;
            HttpResponse::Ok().json(OkResponse { ok: true })
        }
        Err(e) => ise(format!("delete failed: {e}")),
    }
}

// DELETE /share/f/{slug}/folder  { path }  (+ ?pwd=)   [edit]
pub async fn delete_folder(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<PathBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    if let Some(r) = require_edit(&share) {
        return r;
    }
    let dir = match resolve(&share.prefix, &body.path, true) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if dir == share.prefix {
        return bad("cannot delete the share root");
    }
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };
    let objects = match st::collect_objects_under_prefix(&client, &bucket, &dir).await {
        Ok(o) => o,
        Err(e) => return ise(e),
    };
    let mut keys: Vec<String> = objects
        .into_iter()
        .map(|(k, is_dir)| if is_dir && !k.ends_with('/') { format!("{k}/") } else { k })
        .collect();
    keys.push(dir.clone());
    let _ = st::delete_keys_individually(&client, &bucket, keys).await;
    st::prune_empty_parents(&client, &bucket, &dir).await;
    HttpResponse::Ok().json(OkResponse { ok: true })
}

// POST /share/f/{slug}/folder  { path }  (+ ?pwd=)   [edit]   create folder
pub async fn create_folder(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<PathBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    if let Some(r) = require_edit(&share) {
        return r;
    }
    let dir = match resolve(&share.prefix, &body.path, true) {
        Ok(d) => d,
        Err(r) => return r,
    };
    if dir == share.prefix {
        return bad("invalid folder name");
    }
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };
    // A zero-byte object at the trailing-slash key is Bunny's folder marker.
    match client
        .put_object()
        .bucket(&bucket)
        .key(&dir)
        .body(ByteStream::from(Vec::<u8>::new()))
        .send()
        .await
    {
        Ok(_) => HttpResponse::Ok().json(OkResponse { ok: true }),
        Err(e) => ise(format!("create folder failed: {e}")),
    }
}

// POST /share/f/{slug}/move  { from, to }  (+ ?pwd=)   [edit]   rename/move
pub async fn move_item(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    q: web::Query<PwdQuery>,
    body: web::Json<MoveBody>,
) -> impl Responder {
    let share = match fetch_share(pool.get_ref(), &path.into_inner()).await {
        Ok(s) => s,
        Err(r) => return r,
    };
    if let Some(r) = check_pwd(&share, q.pwd.as_deref()) {
        return r;
    }
    if let Some(r) = require_edit(&share) {
        return r;
    }
    let (client, bucket) = match st::s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return ise(e),
    };

    let is_dir = body.from.trim_end_matches(|c| c == ' ').ends_with('/');
    // Build the list of (src, dst) object pairs.
    let pairs: Vec<(String, String)> = if is_dir {
        let from_dir = match resolve(&share.prefix, &body.from, true) {
            Ok(d) => d,
            Err(r) => return r,
        };
        let to_dir = match resolve(&share.prefix, &body.to, true) {
            Ok(d) => d,
            Err(r) => return r,
        };
        if from_dir == share.prefix {
            return bad("cannot move the share root");
        }
        if to_dir.starts_with(&from_dir) {
            return bad("cannot move a folder into itself");
        }
        let objects = match st::collect_objects_under_prefix(&client, &bucket, &from_dir).await {
            Ok(o) => o,
            Err(e) => return ise(e),
        };
        objects
            .into_iter()
            .filter(|(_, is_dir)| !is_dir)
            .map(|(k, _)| {
                let rest = &k[from_dir.len()..];
                (k.clone(), format!("{to_dir}{rest}"))
            })
            .collect()
    } else {
        let from_key = match resolve(&share.prefix, &body.from, false) {
            Ok(k) => k,
            Err(r) => return r,
        };
        let to_key = match resolve(&share.prefix, &body.to, false) {
            Ok(k) => k,
            Err(r) => return r,
        };
        vec![(from_key, to_key)]
    };

    for (from, to) in &pairs {
        let copy_source = format!("{}/{}", bucket, urlencoding::encode(from));
        if let Err(e) = client
            .copy_object()
            .bucket(&bucket)
            .copy_source(&copy_source)
            .key(to)
            .send()
            .await
        {
            return ise(format!("copy failed: {e}"));
        }
        let _ = client.delete_object().bucket(&bucket).key(from).send().await;
    }
    if let Some((from, _)) = pairs.first() {
        st::prune_empty_parents(&client, &bucket, from).await;
    }
    HttpResponse::Ok().json(OkResponse { ok: true })
}

// ════════════════════════════════════════════════════════════════
// Admin endpoints (auth + storage.access)
// ════════════════════════════════════════════════════════════════

fn require_perm(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if check_permission(user, REQUIRED_PERM) {
        None
    } else {
        Some(err(
            actix_web::http::StatusCode::FORBIDDEN,
            format!("Insufficient permissions. Required: {REQUIRED_PERM}"),
        ))
    }
}

// POST /admin/storage/shares
pub async fn create_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<CreateFolderShareRequest>,
) -> impl Responder {
    if let Some(r) = require_perm(&user) {
        return r;
    }
    let prefix = st::normalize_folder(&body.prefix);
    if prefix.is_empty() {
        return bad("cannot share the storage root");
    }
    let access_level = body.access_level.clone().unwrap_or_else(|| "view".into());
    if access_level != "view" && access_level != "edit" {
        return bad("access_level must be 'view' or 'edit'");
    }
    let password_hash = match &body.password {
        Some(p) if !p.is_empty() => match hash_password(p) {
            Ok(h) => Some(h),
            Err(e) => return ise(e),
        },
        _ => None,
    };
    let expires_at = body.expires_in_hours.map(|h| Utc::now() + Duration::hours(h));

    // Unique slug (8 chars).
    let mut slug = generate_slug(8);
    for _ in 0..10 {
        let exists: (bool,) =
            sqlx::query_as("SELECT EXISTS(SELECT 1 FROM db_folder_shares WHERE slug = $1)")
                .bind(&slug)
                .fetch_one(pool.get_ref())
                .await
                .unwrap_or((false,));
        if !exists.0 {
            break;
        }
        slug = generate_slug(8);
    }

    let share = sqlx::query_as::<_, FolderShare>(
        "INSERT INTO db_folder_shares (prefix, slug, access_level, password_hash, expires_at, max_upload_bytes, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, prefix, slug, access_level, password_hash, is_active, expires_at, max_upload_bytes, created_by, created_at, last_accessed_at",
    )
    .bind(&prefix)
    .bind(&slug)
    .bind(&access_level)
    .bind(password_hash)
    .bind(expires_at)
    .bind(body.max_upload_bytes)
    .bind(&user.user_id)
    .fetch_one(pool.get_ref())
    .await;

    match share {
        Ok(s) => HttpResponse::Ok().json(CreateFolderShareResponse {
            id: s.id,
            url: share_url(&s.slug),
            slug: s.slug,
            prefix: s.prefix,
            access_level: s.access_level,
            has_password: s.password_hash.is_some(),
        }),
        Err(e) => {
            log::error!("create folder share: {e}");
            ise("Failed to create share")
        }
    }
}

// GET /admin/storage/shares?prefix=
pub async fn list_shares(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<std::collections::HashMap<String, String>>,
) -> impl Responder {
    if let Some(r) = require_perm(&user) {
        return r;
    }
    let prefix_filter = q.get("prefix").map(|p| st::normalize_folder(p));
    let rows = if let Some(p) = prefix_filter.filter(|p| !p.is_empty()) {
        sqlx::query_as::<_, FolderShare>(
            "SELECT id, prefix, slug, access_level, password_hash, is_active, expires_at, max_upload_bytes, created_by, created_at, last_accessed_at
             FROM db_folder_shares WHERE prefix = $1 ORDER BY created_at DESC",
        )
        .bind(p)
        .fetch_all(pool.get_ref())
        .await
    } else {
        sqlx::query_as::<_, FolderShare>(
            "SELECT id, prefix, slug, access_level, password_hash, is_active, expires_at, max_upload_bytes, created_by, created_at, last_accessed_at
             FROM db_folder_shares ORDER BY created_at DESC",
        )
        .fetch_all(pool.get_ref())
        .await
    };

    match rows {
        Ok(list) => {
            let items: Vec<FolderShareListItem> = list
                .into_iter()
                .map(|s| FolderShareListItem {
                    url: share_url(&s.slug),
                    id: s.id,
                    slug: s.slug,
                    prefix: s.prefix,
                    access_level: s.access_level,
                    has_password: s.password_hash.is_some(),
                    is_active: s.is_active,
                    expires_at: s.expires_at,
                    created_at: s.created_at,
                    last_accessed_at: s.last_accessed_at,
                })
                .collect();
            HttpResponse::Ok().json(items)
        }
        Err(e) => {
            log::error!("list folder shares: {e}");
            ise("Failed to list shares")
        }
    }
}

// PUT /admin/storage/shares/{id}
pub async fn update_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateFolderShareRequest>,
) -> impl Responder {
    if let Some(r) = require_perm(&user) {
        return r;
    }
    let id = path.into_inner();
    let existing = sqlx::query_as::<_, FolderShare>(
        "SELECT id, prefix, slug, access_level, password_hash, is_active, expires_at, max_upload_bytes, created_by, created_at, last_accessed_at
         FROM db_folder_shares WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await
    .ok()
    .flatten();
    let existing = match existing {
        Some(s) => s,
        None => return err(actix_web::http::StatusCode::NOT_FOUND, "Share not found"),
    };

    let mut access_level = existing.access_level.clone();
    if let Some(al) = &body.access_level {
        if al != "view" && al != "edit" {
            return bad("access_level must be 'view' or 'edit'");
        }
        access_level = al.clone();
    }
    let password_hash = match &body.password {
        Some(p) if p.is_empty() => None, // explicit clear
        Some(p) => match hash_password(p) {
            Ok(h) => Some(h),
            Err(e) => return ise(e),
        },
        None => existing.password_hash.clone(),
    };
    let expires_at = match &body.expires_in_hours {
        Some(Some(h)) => Some(Utc::now() + Duration::hours(*h)),
        Some(None) => None,
        None => existing.expires_at,
    };
    let is_active = body.is_active.unwrap_or(existing.is_active);

    let updated = sqlx::query(
        "UPDATE db_folder_shares SET access_level = $1, password_hash = $2, is_active = $3, expires_at = $4 WHERE id = $5",
    )
    .bind(&access_level)
    .bind(&password_hash)
    .bind(is_active)
    .bind(expires_at)
    .bind(id)
    .execute(pool.get_ref())
    .await;

    match updated {
        Ok(_) => HttpResponse::Ok().json(OkResponse { ok: true }),
        Err(e) => {
            log::error!("update folder share: {e}");
            ise("Failed to update share")
        }
    }
}

// POST /admin/storage/shares/{id}/renew — reset created_at to now and push
// expires_at forward by its original lifespan (expires_at − created_at).
pub async fn renew_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if let Some(r) = require_perm(&user) {
        return r;
    }
    let id = path.into_inner();
    let existing: Option<(Option<DateTime<Utc>>, Option<DateTime<Utc>>)> =
        sqlx::query_as("SELECT created_at, expires_at FROM db_folder_shares WHERE id = $1")
            .bind(id)
            .fetch_optional(pool.get_ref())
            .await
            .ok()
            .flatten();
    let (created_at, expires_at) = match existing {
        Some(v) => v,
        None => return err(actix_web::http::StatusCode::NOT_FOUND, "Share not found"),
    };
    let now = Utc::now();
    let new_expires = match (created_at, expires_at) {
        (Some(c), Some(e)) => Some(now + (e - c)),
        _ => expires_at,
    };
    match sqlx::query("UPDATE db_folder_shares SET created_at = $1, expires_at = $2 WHERE id = $3")
        .bind(now)
        .bind(new_expires)
        .bind(id)
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::Ok().json(OkResponse { ok: true }),
        Err(e) => {
            log::error!("renew folder share: {e}");
            ise("Failed to renew share")
        }
    }
}

// DELETE /admin/storage/shares/{id}
pub async fn delete_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if let Some(r) = require_perm(&user) {
        return r;
    }
    match sqlx::query("DELETE FROM db_folder_shares WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::Ok().json(OkResponse { ok: true }),
        Err(e) => {
            log::error!("delete folder share: {e}");
            ise("Failed to delete share")
        }
    }
}

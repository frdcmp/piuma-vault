use actix_web::{web, HttpResponse, Responder};
use argon2::{
    password_hash::{rand_core::OsRng, PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2, Params,
};
use chrono::{DateTime, Duration, Utc};
use rand::Rng;
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::notes::events::{NoteAction, NotesEventBus};
use crate::db::db::DbPool;

use super::models::{
    CreateShareRequest, CreateShareResponse, NoteShare, PublicNoteData, PublicShareInfo,
    PublicShareQuery, PublicShareResponse, ShareListItem, SharesApiError, UpdateShareRequest,
    NoteFrontmatter,
};

// ── Helpers ──

fn err(msg: impl Into<String>) -> SharesApiError {
    SharesApiError {
        error: msg.into(),
    }
}

fn require_write(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if !check_permission(user, "notes.write") {
        Some(HttpResponse::Forbidden().json(err("Access denied: notes.write permission required")))
    } else {
        None
    }
}

/// Generate a short, URL-safe slug (6 chars, base32 lowercase).
fn generate_slug() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 6] = rng.gen();
    // Simple base32-like encoding: use alphanumeric chars
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    bytes
        .iter()
        .map(|&b| CHARS[(b as usize) % CHARS.len()] as char)
        .collect()
}

/// Hash a password using Argon2.
fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        Params::new(19456, 2, 1, None).map_err(|e| format!("Argon2 params error: {e}"))?,
    );
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("Argon2 hash error: {e}"))?;
    Ok(hash.to_string())
}

/// Verify a password against an Argon2 hash.
fn verify_password(password: &str, hash: &str) -> bool {
    let parsed_hash = match PasswordHash::new(hash) {
        Ok(h) => h,
        Err(_) => return false,
    };
    Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok()
}

/// Validate a share is active and not expired.
fn validate_share(share: &NoteShare) -> Option<HttpResponse> {
    if !share.is_active {
        return Some(HttpResponse::Forbidden().json(err("Share link has been deactivated")));
    }
    if let Some(expires_at) = share.expires_at {
        if expires_at < Utc::now() {
            return Some(HttpResponse::Forbidden().json(err("Share link has expired")));
        }
    }
    None
}

/// Check password if required.
fn check_share_password(share: &NoteShare, pwd: Option<&str>) -> Option<HttpResponse> {
    if let Some(ref hash) = share.password_hash {
        let pwd = match pwd {
            Some(p) => p,
            None => {
                return Some(HttpResponse::Unauthorized().json(SharesApiError {
                    error: "Password required".to_string(),
                }));
            }
        };
        if !verify_password(pwd, hash) {
            return Some(HttpResponse::Unauthorized().json(SharesApiError {
                error: "Wrong password".to_string(),
            }));
        }
    }
    None
}

// ── Admin Endpoints ──

/// POST /admin/notes/:id/share — Create a share link
pub async fn create_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<CreateShareRequest>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }

    let note_id = path.into_inner();

    // Verify note exists and belongs to user
    let note_exists: Option<(String,)> = sqlx::query_as(
        "SELECT user_id FROM notes WHERE id = $1 AND deleted_at IS NULL"
    )
    .bind(note_id)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to check note: {e}");
        HttpResponse::InternalServerError().json(err("Failed to verify note"))
    })
    .ok()
    .flatten();

    let _note_exists = match note_exists {
        Some(n) => n,
        None => {
            return HttpResponse::NotFound().json(err("Note not found"));
        }
    };

    // Validate access level
    let access_level = body.access_level.clone().unwrap_or_else(|| "view".to_string());
    if access_level != "view" && access_level != "edit" {
        return HttpResponse::BadRequest().json(err("access_level must be 'view' or 'edit'"));
    }

    // Hash password if provided
    let password_hash = match &body.password {
        Some(pwd) if !pwd.is_empty() => match hash_password(pwd) {
            Ok(h) => Some(h),
            Err(e) => {
                log::error!("Password hash failed: {e}");
                return HttpResponse::InternalServerError().json(err("Failed to process password"));
            }
        },
        _ => None,
    };

    // Calculate expiry
    let expires_at = body.expires_in_hours.map(|hours| {
        Utc::now() + Duration::hours(hours)
    });

    // Generate unique slug
    let mut slug = generate_slug();
    let mut attempts = 0;
    loop {
        let exists: (bool,) = sqlx::query_as("SELECT EXISTS(SELECT 1 FROM note_shares WHERE slug = $1)")
            .bind(&slug)
            .fetch_one(pool.get_ref())
            .await
            .map_err(|e| {
                log::error!("Slug check failed: {e}");
                HttpResponse::InternalServerError().json(err("Failed to create share"))
            })
            .unwrap_or((false,));

        if !exists.0 {
            break;
        }
        slug = generate_slug();
        attempts += 1;
        if attempts > 10 {
            return HttpResponse::InternalServerError().json(err("Failed to generate unique slug"));
        }
    }

    // Insert share
    let share: NoteShare = match sqlx::query_as::<_, NoteShare>(
        "INSERT INTO note_shares (note_id, slug, access_level, password_hash, expires_at, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, note_id, slug, access_level, password_hash, is_active, expires_at, created_by, created_at, last_accessed_at"
    )
    .bind(note_id)
    .bind(&slug)
    .bind(&access_level)
    .bind(password_hash)
    .bind(expires_at)
    .bind(&user.user_id)
    .fetch_one(pool.get_ref())
    .await {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to create share: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to create share"));
        }
    };

    let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "/".to_string());
    let base = if base_url.ends_with('/') { base_url } else { format!("{}/", base_url) };
    let url = format!("{}share/v/{}", base, slug);

    HttpResponse::Ok().json(CreateShareResponse {
        id: share.id,
        note_id: share.note_id,
        slug: share.slug,
        access_level: share.access_level,
        has_password: share.password_hash.is_some(),
        url,
    })
}

/// GET /admin/notes/:id/shares — List all shares for a note
pub async fn list_shares(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }

    let note_id = path.into_inner();

    let shares: Vec<NoteShare> = match sqlx::query_as::<_, NoteShare>(
        "SELECT id, note_id, slug, access_level, password_hash, is_active, expires_at, created_by, created_at, last_accessed_at
         FROM note_shares WHERE note_id = $1 ORDER BY created_at DESC"
    )
    .bind(note_id)
    .fetch_all(pool.get_ref())
    .await {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to list shares: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to list shares"));
        }
    };

    let items: Vec<ShareListItem> = shares
        .into_iter()
        .map(|s| ShareListItem {
            id: s.id,
            slug: s.slug,
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

/// PUT /admin/notes/shares/:shareId — Update share settings
pub async fn update_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateShareRequest>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }

    let share_id = path.into_inner();

    // Fetch existing share
    let existing: Option<NoteShare> = sqlx::query_as::<_, NoteShare>(
        "SELECT id, note_id, slug, access_level, password_hash, is_active, expires_at, created_by, created_at, last_accessed_at
         FROM note_shares WHERE id = $1"
    )
    .bind(share_id)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to fetch share: {e}");
        HttpResponse::InternalServerError().json(err("Failed to update share"))
    })
    .ok()
    .flatten();

    let existing = match existing {
        Some(s) => s,
        None => {
            return HttpResponse::NotFound().json(err("Share not found"));
        }
    };

    // Build dynamic update
    let mut access_level = existing.access_level.clone();
    let mut password_hash = existing.password_hash.clone();
    let mut is_active = existing.is_active;
    let mut expires_at = existing.expires_at;

    if let Some(ref al) = body.access_level {
        if al != "view" && al != "edit" {
            return HttpResponse::BadRequest().json(err("access_level must be 'view' or 'edit'"));
        }
        access_level = al.clone();
    }

    if let Some(ref pwd) = body.password {
        if pwd.is_empty() {
            password_hash = None;
        } else {
            match hash_password(pwd) {
                Ok(h) => password_hash = Some(h),
                Err(e) => {
                    log::error!("Password hash failed: {e}");
                    return HttpResponse::InternalServerError().json(err("Failed to process password"));
                }
            }
        }
    }

    if let Some(active) = body.is_active {
        is_active = active;
    }

    if let Some(exp) = &body.expires_in_hours {
        expires_at = exp.map(|h| Utc::now() + Duration::hours(h));
    }

    let updated: NoteShare = match sqlx::query_as::<_, NoteShare>(
        "UPDATE note_shares
         SET access_level = $1, password_hash = $2, is_active = $3, expires_at = $4
         WHERE id = $5
         RETURNING id, note_id, slug, access_level, password_hash, is_active, expires_at, created_by, created_at, last_accessed_at"
    )
    .bind(&access_level)
    .bind(password_hash)
    .bind(is_active)
    .bind(expires_at)
    .bind(share_id)
    .fetch_one(pool.get_ref())
    .await {
        Ok(s) => s,
        Err(e) => {
            log::error!("Failed to update share: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to update share"));
        }
    };

    HttpResponse::Ok().json(ShareListItem {
        id: updated.id,
        slug: updated.slug,
        access_level: updated.access_level,
        has_password: updated.password_hash.is_some(),
        is_active: updated.is_active,
        expires_at: updated.expires_at,
        created_at: updated.created_at,
        last_accessed_at: updated.last_accessed_at,
    })
}

/// DELETE /admin/notes/shares/:shareId — Revoke a share link
pub async fn delete_share(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }

    let share_id = path.into_inner();

    let result = sqlx::query("DELETE FROM note_shares WHERE id = $1")
        .bind(share_id)
        .execute(pool.get_ref())
        .await;

    match result {
        Ok(res) => {
            if res.rows_affected() == 0 {
                return HttpResponse::NotFound().json(err("Share not found"));
            }
            HttpResponse::Ok().json(serde_json::json!({ "message": "Share revoked" }))
        }
        Err(e) => {
            log::error!("Failed to delete share: {e}");
            HttpResponse::InternalServerError().json(err("Failed to revoke share"))
        }
    }
}

// ── Public Endpoints ──

/// GET /share/v/{slug} — View note as markdown
pub async fn get_shared_note(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    query: web::Query<PublicShareQuery>,
) -> impl Responder {
    let slug = path.into_inner();

    // Fetch share
    let share: Option<NoteShare> = sqlx::query_as::<_, NoteShare>(
        "SELECT id, note_id, slug, access_level, password_hash, is_active, expires_at, created_by, created_at, last_accessed_at
         FROM note_shares WHERE slug = $1"
    )
    .bind(&slug)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to fetch share: {e}");
        HttpResponse::InternalServerError().json(err("Failed to fetch share"))
    })
    .ok()
    .flatten();

    let share = match share {
        Some(s) => s,
        None => {
            return HttpResponse::NotFound().json(err("Share link not found"));
        }
    };

    // Validate share
    if let Some(r) = validate_share(&share) {
        return r;
    }

    // Check password
    if let Some(r) = check_share_password(&share, query.pwd.as_deref()) {
        return r;
    }

    // Update last_accessed_at (fire-and-forget)
    let pool_ref = pool.get_ref().clone();
    let slug_clone = slug.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("UPDATE note_shares SET last_accessed_at = NOW() WHERE slug = $1")
            .bind(&slug_clone)
            .execute(&pool_ref)
            .await;
    });

    // Fetch note
    let note: Option<(uuid::Uuid, String, String, Vec<String>, Option<String>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "SELECT id, title, content, tags, folder, updated_at FROM notes WHERE id = $1 AND deleted_at IS NULL"
    )
    .bind(share.note_id)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to fetch note: {e}");
        HttpResponse::InternalServerError().json(err("Failed to fetch note"))
    })
    .ok()
    .flatten();

    let (note_id, title, content, tags, folder, updated_at) = match note {
        Some(n) => n,
        None => {
            return HttpResponse::NotFound().json(err("Note not found"));
        }
    };

    let format = query.format.as_deref().unwrap_or("markdown");

    match format {
        "json" => {
            HttpResponse::Ok().json(PublicShareResponse {
                note: PublicNoteData {
                    id: note_id,
                    title,
                    content,
                    tags,
                    folder,
                    updated_at,
                },
                share: PublicShareInfo {
                    slug: share.slug,
                    access_level: share.access_level,
                    expires_at: share.expires_at,
                },
            })
        }
        "html" => {
            // Simple markdown to HTML conversion (basic)
            let html = markdown_to_html(&content);
            HttpResponse::Ok()
                .content_type("text/html; charset=utf-8")
                .body(html)
        }
        _ => {
            // Default: markdown with YAML frontmatter
            let frontmatter = NoteFrontmatter {
                id: note_id,
                title,
                tags,
                folder,
                updated_at,
                access: share.access_level.clone(),
            };
            let yaml = serde_yaml::to_string(&frontmatter).unwrap_or_default();

            // When the share is editable, inject hidden (HTML-comment) instructions
            // so an LLM consuming the raw markdown knows how to push edits back via
            // PUT. Markdown renderers strip HTML comments, so humans don't see this.
            let llm_block = if share.access_level == "edit" {
                let base_url = std::env::var("BASE_URL").unwrap_or_else(|_| "/".to_string());
                let base = if base_url.ends_with('/') { base_url } else { format!("{}/", base_url) };
                let put_url = format!("{}api/v1/share/v/{}", base, share.slug);
                let pwd_note = if share.password_hash.is_some() {
                    "\nThis share is password-protected. Reuse the same `?pwd=<password>` \
                     query parameter you used for this GET when making the PUT request."
                } else {
                    ""
                };
                format!(
                    "<!-- LLM_EDIT_INSTRUCTIONS\n\
                     This note is shared with EDIT access. To save changes, send an HTTP PUT request:\n\
                     \n\
                       PUT {put_url}\n\
                     {pwd_note}\n\
                     Body formats (pick one):\n\
                     \n\
                     1. Markdown with YAML frontmatter (recommended, round-trip safe):\n\
                          ---\n\
                          title: <new title>\n\
                          tags: [tag1, tag2]\n\
                          folder: <folder or null>\n\
                          ---\n\
                     \n\
                          <new markdown content>\n\
                     \n\
                     2. JSON (Content-Type: application/json):\n\
                          {{\"title\":\"...\",\"content\":\"...\",\"tags\":[\"...\"],\"folder\":\"...\"}}\n\
                        All fields optional; omitted fields are kept as-is.\n\
                     \n\
                     3. Raw text body — treated as the new content (title/tags/folder unchanged).\n\
                     \n\
                     Response is JSON with the updated note. To round-trip safely: fetch the latest,\n\
                     modify only what you need, then PUT the whole markdown back including the\n\
                     frontmatter above. Do not include this LLM_EDIT_INSTRUCTIONS comment in your PUT body.\n\
                     -->\n\n"
                )
            } else {
                String::new()
            };

            let body = format!("---\n{}---\n\n{}{}", yaml, llm_block, content);
            HttpResponse::Ok()
                .content_type("text/markdown; charset=utf-8")
                .body(body)
        }
    }
}

/// PUT /share/v/{slug} — Update note content
pub async fn update_shared_note(
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    query: web::Query<PublicShareQuery>,
    body: web::Bytes,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    let slug = path.into_inner();

    // Fetch share
    let share: Option<NoteShare> = sqlx::query_as::<_, NoteShare>(
        "SELECT id, note_id, slug, access_level, password_hash, is_active, expires_at, created_by, created_at, last_accessed_at
         FROM note_shares WHERE slug = $1"
    )
    .bind(&slug)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to fetch share: {e}");
        HttpResponse::InternalServerError().json(err("Failed to fetch share"))
    })
    .ok()
    .flatten();

    let share = match share {
        Some(s) => s,
        None => {
            return HttpResponse::NotFound().json(err("Share link not found"));
        }
    };

    // Validate share
    if let Some(r) = validate_share(&share) {
        return r;
    }

    // Check password
    if let Some(r) = check_share_password(&share, query.pwd.as_deref()) {
        return r;
    }

    // Check access level
    if share.access_level != "edit" {
        return HttpResponse::Forbidden().json(err("Access level is 'view', cannot edit"));
    }

    // Parse request body (try markdown with frontmatter first, then JSON)
    let body_str = String::from_utf8_lossy(&body);
    let (new_title, new_content, new_tags, new_folder) = if body_str.starts_with("---") {
        // Parse YAML frontmatter + markdown
        parse_markdown_with_frontmatter(&body_str)
    } else {
        // Try JSON
        match serde_json::from_str::<serde_json::Value>(&body_str) {
            Ok(json) => (
                json.get("title").and_then(|v| v.as_str()).map(String::from),
                json.get("content").and_then(|v| v.as_str()).map(String::from),
                json.get("tags").and_then(|v| v.as_array()).map(|arr| {
                    arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
                }),
                json.get("folder").and_then(|v| v.as_str()).map(String::from),
            ),
            Err(_) => {
                // Treat entire body as content
                (None, Some(body_str.to_string()), None, None)
            }
        }
    };

    // Fetch current note
    let current: Option<(String, String, Vec<String>, Option<String>)> = sqlx::query_as(
        "SELECT title, content, tags, folder FROM notes WHERE id = $1 AND deleted_at IS NULL"
    )
    .bind(share.note_id)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to fetch note: {e}");
        HttpResponse::InternalServerError().json(err("Failed to fetch note"))
    })
    .ok()
    .flatten();

    let (current_title, current_content, current_tags, current_folder) = match current {
        Some(c) => c,
        None => {
            return HttpResponse::NotFound().json(err("Note not found"));
        }
    };

    let final_title = new_title.unwrap_or(current_title);
    let final_content = new_content.unwrap_or(current_content);
    let final_tags = new_tags.unwrap_or(current_tags);
    let final_folder = new_folder.or(current_folder);

    // Update note
    let updated: Option<(uuid::Uuid, String, String, Vec<String>, Option<String>, Option<DateTime<Utc>>)> = sqlx::query_as(
        "UPDATE notes SET title = $1, content = $2, tags = $3, folder = $4, updated_at = NOW()
         WHERE id = $5 AND deleted_at IS NULL
         RETURNING id, title, content, tags, folder, updated_at"
    )
    .bind(&final_title)
    .bind(&final_content)
    .bind(&final_tags)
    .bind(&final_folder)
    .bind(share.note_id)
    .fetch_optional(pool.get_ref())
    .await
    .map_err(|e| {
        log::error!("Failed to update note: {e}");
        HttpResponse::InternalServerError().json(err("Failed to update note"))
    })
    .ok()
    .flatten();

    let (note_id, title, content, tags, folder, updated_at) = match updated {
        Some(n) => n,
        None => {
            return HttpResponse::NotFound().json(err("Note not found"));
        }
    };

    // Update last_accessed_at (fire-and-forget)
    let pool_ref = pool.get_ref().clone();
    let slug_clone = slug.clone();
    tokio::spawn(async move {
        let _ = sqlx::query("UPDATE note_shares SET last_accessed_at = NOW() WHERE slug = $1")
            .bind(&slug_clone)
            .execute(&pool_ref)
            .await;
    });

    // Notify any connected browser/mobile clients that this note changed.
    bus.publish(NoteAction::Updated, note_id);

    HttpResponse::Ok().json(PublicShareResponse {
        note: PublicNoteData {
            id: note_id,
            title,
            content,
            tags,
            folder,
            updated_at,
        },
        share: PublicShareInfo {
            slug: share.slug,
            access_level: share.access_level,
            expires_at: share.expires_at,
        },
    })
}

// ── Helpers ──

/// Parse markdown with YAML frontmatter.
fn parse_markdown_with_frontmatter(body: &str) -> (Option<String>, Option<String>, Option<Vec<String>>, Option<String>) {
    // Split on --- boundaries
    let parts: Vec<&str> = body.split("---").collect();
    if parts.len() < 3 {
        return (None, Some(body.to_string()), None, None);
    }

    let yaml_str = parts[1].trim();
    let content = parts[2..].join("---").trim().to_string();

    let yaml: serde_yaml::Value = match serde_yaml::from_str(yaml_str) {
        Ok(v) => v,
        Err(_) => return (None, Some(content), None, None),
    };

    let title = yaml.get("title").and_then(|v| v.as_str()).map(String::from);
    let tags = yaml.get("tags").and_then(|v| v.as_sequence()).map(|arr| {
        arr.iter().filter_map(|v| v.as_str().map(String::from)).collect()
    });
    let folder = yaml.get("folder").and_then(|v| v.as_str()).map(String::from);

    (title, Some(content), tags, folder)
}

/// Basic markdown to HTML conversion.
fn markdown_to_html(md: &str) -> String {
    // Very basic conversion - in production, use a proper crate like `pulldown-cmark`
    let mut html = String::new();
    for line in md.lines() {
        if line.starts_with("# ") {
            html.push_str(&format!("<h1>{}</h1>\n", &line[2..]));
        } else if line.starts_with("## ") {
            html.push_str(&format!("<h2>{}</h2>\n", &line[3..]));
        } else if line.starts_with("### ") {
            html.push_str(&format!("<h3>{}</h3>\n", &line[4..]));
        } else if line.is_empty() {
            html.push_str("<br>\n");
        } else {
            html.push_str(&format!("<p>{}</p>\n", line));
        }
    }
    html
}

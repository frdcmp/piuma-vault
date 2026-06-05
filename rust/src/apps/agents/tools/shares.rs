//! Shares tools (Tier 3 — outbound) — create / list / update / delete public
//! note share links. Scoped to notes the user owns. Mirrors the shares handler
//! (slug generation + Argon2 password hashing).

use argon2::password_hash::{rand_core::OsRng, PasswordHasher, SaltString};
use argon2::{Argon2, Params};
use chrono::{DateTime, Utc};
use rand::Rng;
use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_shares",
            "List the public share links for a note.",
            json!({
                "type": "object",
                "properties": { "note_id": { "type": "string", "description": "note UUID" } },
                "required": ["note_id"]
            }),
        ),
        (
            "create_share",
            "Create a public share link for a note. Returns the slug + view path. Outbound exposure — confirm with the user first.",
            json!({
                "type": "object",
                "properties": {
                    "note_id": { "type": "string", "description": "note UUID" },
                    "access_level": { "type": "string", "enum": ["view", "edit"], "description": "default view" },
                    "password": { "type": "string", "description": "optional password to protect the link" },
                    "expires_at": { "type": "string", "description": "ISO-8601 expiry (optional)" }
                },
                "required": ["note_id"]
            }),
        ),
        (
            "update_share",
            "Update a share link (access level, active state, expiry, or password).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "share UUID" },
                    "access_level": { "type": "string", "enum": ["view", "edit"] },
                    "is_active": { "type": "boolean" },
                    "expires_at": { "type": "string", "description": "ISO-8601 expiry" },
                    "password": { "type": "string", "description": "set a new password" },
                    "remove_password": { "type": "boolean", "description": "clear the password" }
                },
                "required": ["id"]
            }),
        ),
        (
            "delete_share",
            "Delete (revoke) a public share link. Confirm with the user first.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "share UUID" } },
                "required": ["id"]
            }),
        ),
    ]
}

fn generate_slug() -> String {
    let mut rng = rand::thread_rng();
    let bytes: [u8; 6] = rng.gen();
    const CHARS: &[u8] = b"abcdefghijklmnopqrstuvwxyz234567";
    bytes
        .iter()
        .map(|&b| CHARS[(b as usize) % CHARS.len()] as char)
        .collect()
}

fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::new(
        argon2::Algorithm::Argon2id,
        argon2::Version::V0x13,
        Params::new(19456, 2, 1, None).map_err(|e| format!("argon2 params: {e}"))?,
    );
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| format!("argon2 hash: {e}"))?;
    Ok(hash.to_string())
}

async fn owns_note(pool: &DbPool, user_id: &str, note_id: Uuid) -> Result<bool, String> {
    let owner: Option<String> =
        sqlx::query_scalar("SELECT user_id FROM notes WHERE id = $1 AND deleted_at IS NULL")
            .bind(note_id)
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?;
    Ok(owner.as_deref() == Some(user_id))
}

pub async fn list_shares(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let note_id = uuid_arg(args, "note_id")?;
    if !owns_note(pool, user_id, note_id).await? {
        return Err("note not found".into());
    }
    let rows: Vec<(Uuid, String, String, bool, Option<DateTime<Utc>>, Option<String>)> = sqlx::query_as(
        "SELECT id, slug, access_level, is_active, expires_at, password_hash FROM note_shares \
         WHERE note_id = $1 ORDER BY created_at DESC",
    )
    .bind(note_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let shares: Vec<Value> = rows
        .into_iter()
        .map(|(id, slug, access_level, is_active, expires_at, pw)| {
            json!({
                "id": id, "slug": slug, "access_level": access_level, "is_active": is_active,
                "expires_at": expires_at, "has_password": pw.is_some(),
                "view_path": format!("/api/v1/share/v/{slug}")
            })
        })
        .collect();
    Ok(json!({ "count": shares.len(), "shares": shares }))
}

pub async fn create_share(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let note_id = uuid_arg(args, "note_id")?;
    if !owns_note(pool, user_id, note_id).await? {
        return Err("note not found".into());
    }
    let access_level = opt_string(args, "access_level").unwrap_or_else(|| "view".to_string());
    if access_level != "view" && access_level != "edit" {
        return Err("access_level must be 'view' or 'edit'".into());
    }
    let password_hash = match opt_string(args, "password").filter(|p| !p.is_empty()) {
        Some(pwd) => Some(hash_password(&pwd)?),
        None => None,
    };
    let expires_at = parse_dt(args, "expires_at");

    // Find a free slug (collisions are astronomically unlikely; retry a few).
    let mut slug = generate_slug();
    for _ in 0..5 {
        let taken: bool =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM note_shares WHERE slug = $1)")
                .bind(&slug)
                .fetch_one(pool)
                .await
                .map_err(|e| e.to_string())?;
        if !taken {
            break;
        }
        slug = generate_slug();
    }

    let (id, slug): (Uuid, String) = sqlx::query_as(
        "INSERT INTO note_shares (note_id, slug, access_level, password_hash, expires_at, created_by) \
         VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, slug",
    )
    .bind(note_id)
    .bind(&slug)
    .bind(&access_level)
    .bind(&password_hash)
    .bind(expires_at)
    .bind(user_id)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({
        "id": id, "slug": slug, "access_level": access_level,
        "has_password": password_hash.is_some(), "view_path": format!("/api/v1/share/v/{slug}")
    }))
}

pub async fn update_share(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let access_level = opt_string(args, "access_level");
    if let Some(ref a) = access_level {
        if a != "view" && a != "edit" {
            return Err("access_level must be 'view' or 'edit'".into());
        }
    }
    let is_active = opt_bool(args, "is_active");
    let expires_at = parse_dt(args, "expires_at");
    // Password: explicit set, explicit clear, or leave unchanged.
    let remove_password = opt_bool(args, "remove_password").unwrap_or(false);
    let new_hash = match opt_string(args, "password").filter(|p| !p.is_empty()) {
        Some(pwd) => Some(hash_password(&pwd)?),
        None => None,
    };

    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE note_shares SET \
           access_level = COALESCE($2, access_level), \
           is_active = COALESCE($3, is_active), \
           expires_at = COALESCE($4, expires_at), \
           password_hash = CASE WHEN $5 THEN NULL WHEN $6::text IS NOT NULL THEN $6 ELSE password_hash END \
         WHERE id = $1 AND note_id IN (SELECT id FROM notes WHERE user_id = $7) \
         RETURNING id, slug",
    )
    .bind(id)
    .bind(&access_level)
    .bind(is_active)
    .bind(expires_at)
    .bind(remove_password)
    .bind(&new_hash)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, slug)) => Ok(json!({ "id": id, "slug": slug, "updated": true })),
        None => Err("share not found".into()),
    }
}

pub async fn delete_share(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query(
        "DELETE FROM note_shares WHERE id = $1 AND note_id IN (SELECT id FROM notes WHERE user_id = $2)",
    )
    .bind(id)
    .bind(user_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();
    if affected == 0 {
        return Err("share not found".into());
    }
    Ok(json!({ "id": id, "deleted": true }))
}

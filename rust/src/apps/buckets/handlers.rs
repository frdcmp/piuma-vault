use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::{
    Bucket, BucketsApiError, CreateBucketRequest, CreateTagRequest, Tag, UpdateBucketRequest,
    UpdateTagRequest,
};

const BUCKET_FIELDS: &str = "id, user_id, name, color, sort_order, created_at, updated_at";
const TAG_FIELDS: &str = "id, user_id, name, color, sort_order, created_at, updated_at";

fn err(msg: impl Into<String>) -> BucketsApiError {
    BucketsApiError { error: msg.into() }
}

// Buckets/tags are shared by tasks + calendar, so any read scope on either
// surface grants read; any write scope grants write. `admin_access` is handled
// inside check_permission.
fn require_read(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if check_permission(user, "tasks.read")
        || check_permission(user, "tasks.manage")
        || check_permission(user, "calendar.read")
        || check_permission(user, "calendar.manage")
    {
        None
    } else {
        Some(HttpResponse::Forbidden().json(err(
            "Access denied: tasks/calendar read permission required",
        )))
    }
}

fn require_write(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if check_permission(user, "tasks.write")
        || check_permission(user, "tasks.manage")
        || check_permission(user, "calendar.write")
        || check_permission(user, "calendar.manage")
    {
        None
    } else {
        Some(HttpResponse::Forbidden().json(err(
            "Access denied: tasks/calendar write permission required",
        )))
    }
}

fn validate_name(name: &str) -> Option<HttpResponse> {
    if name.trim().is_empty() {
        return Some(HttpResponse::BadRequest().json(err("Name is required")));
    }
    if name.len() > 100 {
        return Some(HttpResponse::BadRequest().json(err("Name must be 100 chars or fewer")));
    }
    None
}

// ── BUCKETS: LIST ──────────────────────────────────────────────────────────

pub async fn list_buckets(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    let sql = format!(
        "SELECT {BUCKET_FIELDS} FROM db_buckets WHERE user_id = $1 ORDER BY sort_order ASC, lower(name) ASC"
    );
    match sqlx::query_as::<_, Bucket>(&sql)
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(data) => HttpResponse::Ok().json(data),
        Err(e) => {
            log::error!("buckets list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch buckets"))
        }
    }
}

// ── BUCKETS: CREATE ──────────────────────────────────────────────────────────

pub async fn create_bucket(
    user: AuthenticatedUser,
    body: web::Json<CreateBucketRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    if let Some(r) = validate_name(&body.name) {
        return r;
    }
    let sql = format!(
        "INSERT INTO db_buckets (user_id, name, color, sort_order) \
         VALUES ($1, $2, $3, $4) RETURNING {BUCKET_FIELDS}"
    );
    match sqlx::query_as::<_, Bucket>(&sql)
        .bind(&user.user_id)
        .bind(body.name.trim())
        .bind(&body.color)
        .bind(body.sort_order)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(bucket) => HttpResponse::Created().json(bucket),
        Err(e) => {
            log::error!("buckets create failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to create bucket (name may already exist)"))
        }
    }
}

// ── BUCKETS: UPDATE ──────────────────────────────────────────────────────────

pub async fn update_bucket(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateBucketRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    if let Some(ref name) = body.name {
        if let Some(r) = validate_name(name) {
            return r;
        }
    }
    let (set_color, color) = match &body.color {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };
    let sql = format!(
        "UPDATE db_buckets SET \
            name = COALESCE($3, name), \
            color = CASE WHEN $4 THEN $5 ELSE color END, \
            sort_order = COALESCE($6, sort_order), \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {BUCKET_FIELDS}"
    );
    match sqlx::query_as::<_, Bucket>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(body.name.as_deref().map(str::trim))
        .bind(set_color)
        .bind(color)
        .bind(body.sort_order)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(bucket)) => HttpResponse::Ok().json(bucket),
        Ok(None) => HttpResponse::NotFound().json(err("Bucket not found")),
        Err(e) => {
            log::error!("buckets update failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to update bucket"))
        }
    }
}

// ── BUCKETS: DELETE ──────────────────────────────────────────────────────────
// ON DELETE SET NULL drops the bucket's tags to the Inbox group automatically.

pub async fn delete_bucket(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    match sqlx::query("DELETE FROM db_buckets WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() == 0 => {
            HttpResponse::NotFound().json(err("Bucket not found"))
        }
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("buckets delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete bucket"))
        }
    }
}

// ── TAGS: LIST ────────────────────────────────────────────────────────────────

pub async fn list_tags(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    let sql = format!(
        "SELECT {TAG_FIELDS} FROM db_tags WHERE user_id = $1 ORDER BY sort_order ASC, lower(name) ASC"
    );
    match sqlx::query_as::<_, Tag>(&sql)
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(data) => HttpResponse::Ok().json(data),
        Err(e) => {
            log::error!("tags list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch tags"))
        }
    }
}

// ── TAGS: CREATE ──────────────────────────────────────────────────────────────

pub async fn create_tag(
    user: AuthenticatedUser,
    body: web::Json<CreateTagRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    if let Some(r) = validate_name(&body.name) {
        return r;
    }
    // Tag names are stored lowercased to match the bare names used on tasks/events.
    let name = body.name.trim().to_lowercase();
    let sql = format!(
        "INSERT INTO db_tags (user_id, name, color, sort_order) \
         VALUES ($1, $2, $3, $4) RETURNING {TAG_FIELDS}"
    );
    match sqlx::query_as::<_, Tag>(&sql)
        .bind(&user.user_id)
        .bind(&name)
        .bind(&body.color)
        .bind(body.sort_order)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(tag) => HttpResponse::Created().json(tag),
        Err(e) => {
            log::error!("tags create failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to create tag (name may already exist)"))
        }
    }
}

// ── TAGS: UPDATE ──────────────────────────────────────────────────────────────
// Rename / recolor / reorder. Tags are flat — there is no bucket to move.

pub async fn update_tag(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateTagRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    if let Some(ref name) = body.name {
        if let Some(r) = validate_name(name) {
            return r;
        }
    }
    // Tag names live only in db_tags (entities reference tags by id), so a rename
    // is a single update — nothing to propagate.
    let new_name = body.name.as_ref().map(|n| n.trim().to_lowercase());

    let (set_color, color) = match &body.color {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };

    let sql = format!(
        "UPDATE db_tags SET \
            name = COALESCE($3, name), \
            color = CASE WHEN $4 THEN $5 ELSE color END, \
            sort_order = COALESCE($6, sort_order), \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {TAG_FIELDS}"
    );
    match sqlx::query_as::<_, Tag>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(new_name.as_deref())
        .bind(set_color)
        .bind(color)
        .bind(body.sort_order)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(t)) => HttpResponse::Ok().json(t),
        Ok(None) => HttpResponse::NotFound().json(err("Tag not found")),
        Err(e) => {
            log::error!("tags update failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to update tag (name may exist)"))
        }
    }
}

// ── TAGS: DELETE ──────────────────────────────────────────────────────────────
// Removes the registry entry only. The bare name may still live in task/event
// arrays; it simply reverts to an unregistered tag (re-created uncategorized on
// the next write that uses it).

pub async fn delete_tag(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    match sqlx::query("DELETE FROM db_tags WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() == 0 => HttpResponse::NotFound().json(err("Tag not found")),
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("tags delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete tag"))
        }
    }
}

use actix_web::{web, HttpResponse, Responder};
use std::collections::HashMap;
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::{
    Bucket, BucketNode, BucketsApiError, CreateBucketRequest, CreateTagRequest, Tag, TagNode,
    TreeQuery, TreeResponse, UpdateBucketRequest, UpdateTagRequest,
};

const BUCKET_FIELDS: &str = "id, user_id, name, color, sort_order, created_at, updated_at";
const TAG_FIELDS: &str =
    "id, user_id, bucket_id, name, color, sort_order, created_at, updated_at";

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
    // Tag names are stored lowercased to match the bare names in tasks/events arrays.
    let name = body.name.trim().to_lowercase();
    let sql = format!(
        "INSERT INTO db_tags (user_id, bucket_id, name, color, sort_order) \
         VALUES ($1, $2, $3, $4, $5) RETURNING {TAG_FIELDS}"
    );
    match sqlx::query_as::<_, Tag>(&sql)
        .bind(&user.user_id)
        .bind(body.bucket_id)
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
// A rename rewrites the tag name across all three array columns (tasks,
// recurring templates, calendar events) in one transaction.

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
    // Tag names live only in db_tags now (entities reference tags by id), so a
    // rename is a single update — nothing to propagate.
    let new_name = body.name.as_ref().map(|n| n.trim().to_lowercase());

    let (set_bucket, bucket) = match &body.bucket_id {
        Some(v) => (true, *v),
        None => (false, None),
    };
    let (set_color, color) = match &body.color {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };

    let sql = format!(
        "UPDATE db_tags SET \
            name = COALESCE($3, name), \
            bucket_id = CASE WHEN $4 THEN $5 ELSE bucket_id END, \
            color = CASE WHEN $6 THEN $7 ELSE color END, \
            sort_order = COALESCE($8, sort_order), \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {TAG_FIELDS}"
    );
    match sqlx::query_as::<_, Tag>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(new_name.as_deref())
        .bind(set_bucket)
        .bind(bucket)
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

// ── TREE (filter UI feed) ──────────────────────────────────────────────────────

pub async fn get_tree(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<TreeQuery>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }

    let buckets = match sqlx::query_as::<_, Bucket>(&format!(
        "SELECT {BUCKET_FIELDS} FROM db_buckets WHERE user_id = $1 ORDER BY sort_order ASC, lower(name) ASC"
    ))
    .bind(&user.user_id)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(b) => b,
        Err(e) => {
            log::error!("tree buckets failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to build tag tree"));
        }
    };

    let tags = match sqlx::query_as::<_, Tag>(&format!(
        "SELECT {TAG_FIELDS} FROM db_tags WHERE user_id = $1 ORDER BY sort_order ASC, lower(name) ASC"
    ))
    .bind(&user.user_id)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(t) => t,
        Err(e) => {
            log::error!("tree tags failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to build tag tree"));
        }
    };

    // Per-tag usage counts, scoped to the requested surface (keyed by tag id).
    let counts: HashMap<Uuid, i64> = match query.counts.as_deref() {
        Some("tasks") => count_usage(
            pool.get_ref(),
            &user.user_id,
            "SELECT tt.tag_id, COUNT(*) AS n FROM db_task_tags tt \
             JOIN db_tasks t ON t.id = tt.task_id \
             WHERE t.user_id = $1 AND t.recurrence_id IS NULL GROUP BY tt.tag_id",
        )
        .await,
        Some("calendar") => count_usage(
            pool.get_ref(),
            &user.user_id,
            "SELECT et.tag_id, COUNT(*) AS n FROM db_event_tags et \
             JOIN db_calendar_events e ON e.id = et.event_id \
             WHERE e.user_id = $1 GROUP BY et.tag_id",
        )
        .await,
        _ => HashMap::new(),
    };

    let node = |t: &Tag| TagNode {
        id: t.id,
        name: t.name.clone(),
        color: t.color.clone(),
        sort_order: t.sort_order,
        count: *counts.get(&t.id).unwrap_or(&0),
    };

    let bucket_nodes: Vec<BucketNode> = buckets
        .iter()
        .map(|b| BucketNode {
            id: b.id,
            name: b.name.clone(),
            color: b.color.clone(),
            sort_order: b.sort_order,
            tags: tags
                .iter()
                .filter(|t| t.bucket_id == Some(b.id))
                .map(node)
                .collect(),
        })
        .collect();

    let inbox: Vec<TagNode> = tags
        .iter()
        .filter(|t| t.bucket_id.is_none())
        .map(node)
        .collect();

    HttpResponse::Ok().json(TreeResponse {
        buckets: bucket_nodes,
        inbox,
    })
}

async fn count_usage(pool: &DbPool, user_id: &str, sql: &str) -> HashMap<Uuid, i64> {
    match sqlx::query_as::<_, (Uuid, i64)>(sql)
        .bind(user_id)
        .fetch_all(pool)
        .await
    {
        Ok(rows) => rows.into_iter().collect(),
        Err(e) => {
            log::error!("tag usage count failed: {e}");
            HashMap::new()
        }
    }
}

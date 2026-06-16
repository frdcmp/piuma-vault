use actix_web::{web, HttpResponse, Responder};
use serde::Deserialize;
use uuid::Uuid;

use super::core;
use super::models::{GenerateRequest, GeneratedImageRow};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::storage::handlers::s3_client;
use crate::db::db::DbPool;

const REQUIRED_PERM: &str = "admin_access";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": "admin_access required" }))
}

fn server_err(msg: impl Into<String>) -> HttpResponse {
    HttpResponse::InternalServerError().json(serde_json::json!({ "error": msg.into() }))
}

/// POST /images/generate — generate (and store) one or more images.
pub async fn generate(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<GenerateRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let req = body.into_inner();
    let prompt = req.prompt.trim();
    if prompt.is_empty() {
        return HttpResponse::BadRequest().json(serde_json::json!({ "error": "`prompt` is required" }));
    }
    let size = req
        .size
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "1024x1024".to_string());
    let n = req.n.unwrap_or(1).clamp(1, 4);

    match core::generate_and_store(pool.get_ref(), &user.user_id, prompt, &size, n, "api").await {
        Ok(images) => HttpResponse::Ok().json(serde_json::json!({ "images": images })),
        Err(e) => server_err(e),
    }
}

#[derive(Debug, Deserialize)]
pub struct ListQuery {
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

/// GET /images — paginated generation history (newest first).
pub async fn list_images(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<ListQuery>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let limit = q.limit.unwrap_or(50).clamp(1, 200);
    let offset = q.offset.unwrap_or(0).max(0);
    let rows = sqlx::query_as::<_, GeneratedImageRow>(
        "SELECT id, prompt, revised_prompt, provider, model, size, storage_key, cdn_url, mime, source, created_at
           FROM db_generated_images
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT $2 OFFSET $3",
    )
    .bind(&user.user_id)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await;
    match rows {
        Ok(images) => HttpResponse::Ok().json(serde_json::json!({ "images": images })),
        Err(e) => server_err(format!("list failed: {e}")),
    }
}

/// GET /images/{id} — a single generation record.
pub async fn get_image(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let row = sqlx::query_as::<_, GeneratedImageRow>(
        "SELECT id, prompt, revised_prompt, provider, model, size, storage_key, cdn_url, mime, source, created_at
           FROM db_generated_images
          WHERE id = $1 AND user_id = $2",
    )
    .bind(path.into_inner())
    .bind(&user.user_id)
    .fetch_optional(pool.get_ref())
    .await;
    match row {
        Ok(Some(image)) => HttpResponse::Ok().json(image),
        Ok(None) => HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" })),
        Err(e) => server_err(format!("read failed: {e}")),
    }
}

/// DELETE /images/{id} — remove the record and its S3 object.
pub async fn delete_image(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let pool = pool.get_ref();
    let key: Option<String> = match sqlx::query_scalar::<_, String>(
        "DELETE FROM db_generated_images WHERE id = $1 AND user_id = $2 RETURNING storage_key",
    )
    .bind(path.into_inner())
    .bind(&user.user_id)
    .fetch_optional(pool)
    .await
    {
        Ok(k) => k,
        Err(e) => return server_err(format!("delete failed: {e}")),
    };
    let Some(key) = key else {
        return HttpResponse::NotFound().json(serde_json::json!({ "error": "not found" }));
    };
    // Best-effort object removal; the row is already gone.
    if let Ok((client, bucket)) = s3_client(pool).await {
        if let Err(e) = client.delete_object().bucket(&bucket).key(&key).send().await {
            log::warn!("delete_image: failed to remove S3 object {key}: {e}");
        }
    }
    HttpResponse::Ok().json(serde_json::json!({ "deleted": true }))
}

use actix_web::{web, HttpResponse, Responder};

use super::models::{
    ServiceConfigResponse, TestEmbeddingRequest, TestOpenclawRequest, TestStorageRequest,
    UpdateServiceConfig,
};
use super::store;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::embeddings as embedding;
use crate::db::db::DbPool;

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": "admin_access required" }))
}

/// Build the masked service-config view (URLs in plain, secrets as `*_set`).
async fn current_config(pool: &DbPool) -> ServiceConfigResponse {
    ServiceConfigResponse {
        azure_embedding_url: store::get(pool, store::AZURE_EMBEDDING_URL)
            .await
            .unwrap_or_default(),
        azure_embedding_api_key_set: store::get(pool, store::AZURE_EMBEDDING_API_KEY)
            .await
            .is_some(),
        openclaw_url: store::get(pool, store::OPENCLAW_URL).await.unwrap_or_default(),
        openclaw_gateway_token_set: store::get(pool, store::OPENCLAW_GATEWAY_TOKEN)
            .await
            .is_some(),
        s3_endpoint: store::get(pool, store::S3_ENDPOINT).await.unwrap_or_default(),
        s3_region: store::get(pool, store::S3_REGION).await.unwrap_or_default(),
        s3_bucket: store::get(pool, store::S3_BUCKET).await.unwrap_or_default(),
        s3_access_key_id: store::get(pool, store::S3_ACCESS_KEY_ID)
            .await
            .unwrap_or_default(),
        s3_secret_access_key_set: store::get(pool, store::S3_SECRET_ACCESS_KEY)
            .await
            .is_some(),
        s3_cdn_url: store::get(pool, store::S3_CDN_URL).await.unwrap_or_default(),
        s3_cdn_token_key_set: store::get(pool, store::S3_CDN_TOKEN_KEY).await.is_some(),
    }
}

/// GET /admin/settings/services — current service config (secrets masked).
pub async fn get_services(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    HttpResponse::Ok().json(current_config(pool.get_ref()).await)
}

/// PUT /admin/settings/services — update any subset of service config.
///
/// Per field: omitted = keep, empty string = clear, non-empty = set.
pub async fn update_services(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<UpdateServiceConfig>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }

    let pool = pool.get_ref();
    let body = body.into_inner();

    let updates = [
        (store::AZURE_EMBEDDING_URL, body.azure_embedding_url),
        (store::AZURE_EMBEDDING_API_KEY, body.azure_embedding_api_key),
        (store::OPENCLAW_URL, body.openclaw_url),
        (store::OPENCLAW_GATEWAY_TOKEN, body.openclaw_gateway_token),
        (store::S3_ENDPOINT, body.s3_endpoint),
        (store::S3_REGION, body.s3_region),
        (store::S3_BUCKET, body.s3_bucket),
        (store::S3_ACCESS_KEY_ID, body.s3_access_key_id),
        (store::S3_SECRET_ACCESS_KEY, body.s3_secret_access_key),
        (store::S3_CDN_URL, body.s3_cdn_url),
        (store::S3_CDN_TOKEN_KEY, body.s3_cdn_token_key),
    ];

    for (key, maybe_value) in updates {
        if let Some(value) = maybe_value {
            if let Err(e) = store::set(pool, key, value.trim()).await {
                log::error!("Failed to save setting {key}: {e}");
                return HttpResponse::InternalServerError()
                    .json(serde_json::json!({ "error": "Failed to save settings" }));
            }
        }
    }

    HttpResponse::Ok().json(current_config(pool).await)
}

/// Shared shape for "try now" results. Always HTTP 200; `ok` carries the verdict
/// so the dashboard can render success/failure without treating it as an error.
fn test_result(ok: bool, message: impl Into<String>) -> HttpResponse {
    HttpResponse::Ok().json(serde_json::json!({ "ok": ok, "message": message.into() }))
}

/// POST /admin/settings/services/test/embedding — live-check the Azure config.
/// An optional body lets the dashboard test unsaved form values; blank fields
/// fall back to the saved config.
pub async fn test_embedding(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: Option<web::Json<TestEmbeddingRequest>>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let req = body.map(|b| b.into_inner()).unwrap_or_default();
    let (url, api_key) = match store::embedding_config_with(
        pool.get_ref(),
        req.azure_embedding_url,
        req.azure_embedding_api_key,
    )
    .await
    {
        Ok(cfg) => cfg,
        Err(e) => return test_result(false, e),
    };
    match embedding::embed_with("connection test", 1536, &url, &api_key).await {
        Ok(v) => test_result(true, format!("OK — received a {}-dim embedding", v.len())),
        Err(e) => test_result(false, e),
    }
}

/// POST /admin/settings/services/test/openclaw — check the gateway is reachable
/// and accepts the token (GET /v1/models, no inference). An optional body lets
/// the dashboard test unsaved form values; blank fields fall back to saved config.
pub async fn test_openclaw(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: Option<web::Json<TestOpenclawRequest>>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let req = body.map(|b| b.into_inner()).unwrap_or_default();
    let (base, token) = match store::openclaw_config_with(
        pool.get_ref(),
        req.openclaw_url,
        req.openclaw_gateway_token,
    )
    .await
    {
        Ok(cfg) => cfg,
        Err(e) => return test_result(false, e),
    };
    let url = format!("{}/v1/models", base.trim_end_matches('/'));
    let req = reqwest::Client::new()
        .get(&url)
        .bearer_auth(&token)
        .timeout(std::time::Duration::from_secs(8));
    match req.send().await {
        Ok(r) if r.status().is_success() => {
            test_result(true, format!("OK — gateway reachable ({})", r.status()))
        }
        Ok(r) => test_result(false, format!("Gateway returned HTTP {}", r.status())),
        Err(e) => test_result(false, format!("Connection failed: {e}")),
    }
}

/// POST /admin/settings/services/test/storage — check the S3 config can reach
/// the bucket (a single list_objects_v2 call, no writes). An optional body lets
/// the dashboard test unsaved form values; blank fields fall back to saved config.
pub async fn test_storage(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: Option<web::Json<TestStorageRequest>>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let req = body.map(|b| b.into_inner()).unwrap_or_default();
    let overrides = store::S3Override {
        endpoint: req.s3_endpoint,
        region: req.s3_region,
        bucket: req.s3_bucket,
        access_key_id: req.s3_access_key_id,
        secret_access_key: req.s3_secret_access_key,
    };
    match crate::apps::storage::handlers::test_connection(
        pool.get_ref(),
        overrides,
        req.s3_cdn_url,
        req.s3_cdn_token_key,
    )
    .await
    {
        Ok(msg) => test_result(true, msg),
        Err(e) => test_result(false, e),
    }
}

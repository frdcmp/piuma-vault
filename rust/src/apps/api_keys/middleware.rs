use super::models::ApiKeyRow;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;
use actix_web::{web, Error, HttpRequest};
use sha2::{Digest, Sha256};

/// Compute SHA-256 hex digest of a raw API key string.
pub fn hash_api_key(raw_key: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(raw_key.as_bytes());
    format!("{:x}", hasher.finalize())
}

/// Look up an API key by its hash in the database.
/// Returns the full row if found and active (and not expired).
pub async fn lookup_api_key(
    pool: &DbPool,
    key_hash: &str,
) -> Result<Option<ApiKeyRow>, Error> {
    let row = sqlx::query_as::<_, ApiKeyRow>(
        "SELECT id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at \
         FROM api_keys WHERE key_hash = $1 AND is_active = TRUE"
    )
    .bind(key_hash)
    .fetch_optional(pool)
    .await
    .map_err(|e| {
        log::error!("Database error looking up API key: {:?}", e);
        actix_web::error::ErrorUnauthorized("Authentication error")
    })?;

    // Check expiration
    if let Some(ref row_data) = row {
        if let Some(expires) = row_data.expires_at {
            if expires < chrono::Utc::now() {
                return Ok(None); // Expired
            }
        }
    }

    Ok(row)
}

/// Update last_used_at for an API key (fire-and-forget).
pub async fn touch_api_key(pool: &DbPool, key_id: &uuid::Uuid) {
    let _ = sqlx::query("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1")
        .bind(key_id)
        .execute(pool)
        .await;
}

/// Extractor that tries JWT Bearer auth first, then falls back to x-api-key header.
/// This allows all existing handlers to accept both auth methods transparently.
impl actix_web::FromRequest for AuthenticatedUser {
    type Error = actix_web::Error;
    type Future = std::pin::Pin<Box<dyn std::future::Future<Output = Result<Self, Self::Error>>>>;

    fn from_request(req: &HttpRequest, _payload: &mut actix_web::dev::Payload) -> Self::Future {
        let auth_header = req.headers().get("Authorization").cloned();
        let api_key_header = req.headers().get("x-api-key").cloned();
        let pool = req.app_data::<web::Data<DbPool>>().cloned();

        Box::pin(async move {
            // 1) Try JWT Bearer token first
            if let Some(auth_val) = &auth_header {
                if let Ok(auth_str) = auth_val.to_str() {
                    if auth_str.starts_with("Bearer ") || auth_str.starts_with("bearer ") {
                        let token = auth_str[7..].to_string();
                        match crate::apps::auth::middleware::Auth::validate_token(&token) {
                            Ok(claims) => {
                                if claims.token_type != "access" {
                                    return Err(actix_web::error::ErrorUnauthorized("Invalid token type"));
                                }
                                return Ok(AuthenticatedUser {
                                    user_id: claims.sub,
                                    email: claims.email.unwrap_or_default(),
                                    first_name: claims.first_name,
                                    last_name: claims.last_name,
                                    permissions: claims.permissions,
                                    groups: claims.groups,
                                });
                            }
                            Err(e) => {
                                return Err(e);
                            }
                        }
                    }
                }
            }

            // 2) No valid JWT — try x-api-key
            if let Some(api_key_val) = &api_key_header {
                if let Ok(raw_key) = api_key_val.to_str() {
                    if !raw_key.is_empty() {
                        let pool = match &pool {
                            Some(p) => p,
                            None => {
                                return Err(actix_web::error::ErrorUnauthorized(
                                    "Internal error: no database pool",
                                ));
                            }
                        };
                        let key_hash = hash_api_key(raw_key);
                        let pool_ref = pool.get_ref();
                        match lookup_api_key(pool_ref, &key_hash).await {
                            Ok(Some(row)) => {
                                let touch_pool = pool.clone();
                                let touch_id = row.id;
                                tokio::spawn(async move {
                                    touch_api_key(touch_pool.get_ref(), &touch_id).await;
                                });
                                return Ok(AuthenticatedUser {
                                    user_id: row.created_by.clone().unwrap_or_else(|| format!("api-key:{}", row.key_prefix)),
                                    email: format!("api-key:{}", row.key_prefix),
                                    first_name: Some("API Key".to_string()),
                                    last_name: Some(row.name.clone()),
                                    permissions: row.permissions,
                                    groups: vec!["api-key".to_string()],
                                });
                            }
                            Ok(None) => {
                                return Err(actix_web::error::ErrorUnauthorized(
                                    "Invalid or expired API key",
                                ));
                            }
                            Err(e) => return Err(e),
                        }
                    }
                }
            }

            // 3) No auth at all
            Err(actix_web::error::ErrorUnauthorized(
                "Authentication required",
            ))
        })
    }
}
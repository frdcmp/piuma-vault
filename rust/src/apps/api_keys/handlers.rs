use super::models::{
    ApiErrorResponse, ApiKeyResponse, ApiKeyRow, CreateApiKeyRequest, CreateApiKeyResponse,
    RevokeApiKeyResponse, UpdateApiKeyRequest,
};
use crate::apps::api_keys::middleware::hash_api_key;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;
use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

// ── List all API keys (masked) ──

pub async fn list_api_keys(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden().json(ApiErrorResponse {
            error: "Admin access required".to_string(),
        });
    }

    let rows = sqlx::query_as::<_, ApiKeyRow>(
        "SELECT id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at \
         FROM api_keys ORDER BY created_at DESC"
    )
    .fetch_all(pool.get_ref())
    .await;

    match rows {
        Ok(rows) => {
            let keys: Vec<ApiKeyResponse> = rows.into_iter().map(row_to_response).collect();
            HttpResponse::Ok().json(keys)
        }
        Err(e) => {
            log::error!("Error listing API keys: {:?}", e);
            HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to list API keys".to_string(),
            })
        }
    }
}

// ── Get single API key ──

pub async fn get_api_key(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden().json(ApiErrorResponse {
            error: "Admin access required".to_string(),
        });
    }

    let id = path.into_inner();
    let row = sqlx::query_as::<_, ApiKeyRow>(
        "SELECT id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at \
         FROM api_keys WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await;

    match row {
        Ok(Some(row)) => HttpResponse::Ok().json(row_to_response(row)),
        Ok(None) => HttpResponse::NotFound().json(ApiErrorResponse {
            error: "API key not found".to_string(),
        }),
        Err(e) => {
            log::error!("Error fetching API key: {:?}", e);
            HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to fetch API key".to_string(),
            })
        }
    }
}

// ── Create API key ──

pub async fn create_api_key(
    user: AuthenticatedUser,
    body: web::Json<CreateApiKeyRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden().json(ApiErrorResponse {
            error: "Admin access required".to_string(),
        });
    }

    // Generate a raw key: frd_ + 32 hex chars
    let raw_key = format!("frd_{}", Uuid::new_v4().to_string().replace("-", ""));
    let key_prefix = raw_key[..8].to_string();
    let key_hash = hash_api_key(&raw_key);
    let created_by = user.user_id.clone();

    let permissions = if body.permissions.is_empty() {
        vec!["notes.read".to_string(), "notes.write".to_string()]
    } else {
        body.permissions.clone()
    };

    let row = sqlx::query_as::<_, ApiKeyRow>(
        "INSERT INTO api_keys (name, key_prefix, key_hash, permissions, created_by, is_active, expires_at) \
         VALUES ($1, $2, $3, $4, $5, TRUE, $6) \
         RETURNING id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at"
    )
    .bind(&body.name)
    .bind(&key_prefix)
    .bind(&key_hash)
    .bind(&permissions)
    .bind(&created_by)
    .bind(body.expires_at)
    .fetch_one(pool.get_ref())
    .await;

    match row {
        Ok(row) => HttpResponse::Created().json(CreateApiKeyResponse {
            id: row.id,
            name: row.name,
            key_prefix: row.key_prefix,
            raw_key,
            permissions: row.permissions,
            is_active: row.is_active,
            expires_at: row.expires_at,
            created_at: row.created_at,
        }),
        Err(e) => {
            log::error!("Error creating API key: {:?}", e);
            HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to create API key".to_string(),
            })
        }
    }
}

// ── Update API key ──

pub async fn update_api_key(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateApiKeyRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden().json(ApiErrorResponse {
            error: "Admin access required".to_string(),
        });
    }

    let id = path.into_inner();

    // Build dynamic UPDATE query based on provided fields
    let current = sqlx::query_as::<_, ApiKeyRow>(
        "SELECT id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at \
         FROM api_keys WHERE id = $1"
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await;

    let current = match current {
        Ok(Some(row)) => row,
        Ok(None) => {
            return HttpResponse::NotFound().json(ApiErrorResponse {
                error: "API key not found".to_string(),
            })
        }
        Err(e) => {
            log::error!("Error fetching API key for update: {:?}", e);
            return HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to fetch API key".to_string(),
            });
        }
    };

    let name = body.name.as_ref().unwrap_or(&current.name);
    let permissions = body
        .permissions
        .as_ref()
        .unwrap_or(&current.permissions);
    let is_active = body.is_active.unwrap_or(current.is_active);
    let expires_at = body.expires_at.as_ref().unwrap_or(&current.expires_at);

    let row = sqlx::query_as::<_, ApiKeyRow>(
        "UPDATE api_keys SET name = $1, permissions = $2, is_active = $3, expires_at = $4, updated_at = NOW() \
         WHERE id = $5 \
         RETURNING id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at"
    )
    .bind(name)
    .bind(permissions)
    .bind(is_active)
    .bind(expires_at)
    .bind(id)
    .fetch_one(pool.get_ref())
    .await;

    match row {
        Ok(row) => HttpResponse::Ok().json(row_to_response(row)),
        Err(e) => {
            log::error!("Error updating API key: {:?}", e);
            HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to update API key".to_string(),
            })
        }
    }
}

// ── Revoke (soft-delete) API key ──

pub async fn revoke_api_key(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden().json(ApiErrorResponse {
            error: "Admin access required".to_string(),
        });
    }

    let id = path.into_inner();
    let result = sqlx::query_as::<_, ApiKeyRow>(
        "UPDATE api_keys SET is_active = FALSE, updated_at = NOW() WHERE id = $1 \
         RETURNING id, name, key_prefix, key_hash, permissions, created_by, is_active, last_used_at, expires_at, created_at, updated_at"
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await;

    match result {
        Ok(Some(row)) => HttpResponse::Ok().json(RevokeApiKeyResponse {
            id: row.id,
            is_active: row.is_active,
        }),
        Ok(None) => HttpResponse::NotFound().json(ApiErrorResponse {
            error: "API key not found".to_string(),
        }),
        Err(e) => {
            log::error!("Error revoking API key: {:?}", e);
            HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to revoke API key".to_string(),
            })
        }
    }
}

// ── Hard-delete API key ──

pub async fn delete_api_key(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden().json(ApiErrorResponse {
            error: "Admin access required".to_string(),
        });
    }

    let id = path.into_inner();
    let result = sqlx::query("DELETE FROM api_keys WHERE id = $1")
        .bind(id)
        .execute(pool.get_ref())
        .await;

    match result {
        Ok(result) => {
            if result.rows_affected() > 0 {
                HttpResponse::Ok().json(serde_json::json!({ "message": "API key deleted" }))
            } else {
                HttpResponse::NotFound().json(ApiErrorResponse {
                    error: "API key not found".to_string(),
                })
            }
        }
        Err(e) => {
            log::error!("Error deleting API key: {:?}", e);
            HttpResponse::InternalServerError().json(ApiErrorResponse {
                error: "Failed to delete API key".to_string(),
            })
        }
    }
}

// ── Helper ──

fn row_to_response(row: ApiKeyRow) -> ApiKeyResponse {
    ApiKeyResponse {
        id: row.id,
        name: row.name,
        key_prefix: row.key_prefix,
        permissions: row.permissions,
        created_by: row.created_by,
        is_active: row.is_active,
        last_used_at: row.last_used_at,
        expires_at: row.expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}
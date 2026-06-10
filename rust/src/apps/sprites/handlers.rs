use super::models::{
    ActiveSpriteResponse, CreateSpriteRequest, ErrorResponse, SetActiveRequest, SpriteResponse,
    SpriteRow, UpdateSpriteRequest,
};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::settings::store;
use crate::db::db::DbPool;
use actix_web::{web, HttpResponse, Responder};

/// `app_settings` key holding the active mascot's sprite key.
pub const ACTIVE_KEY: &str = "active_sprite";
/// Fallback mascot when nothing is selected yet.
pub const DEFAULT_KEY: &str = "piuma";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(ErrorResponse {
        error: "Admin access required".to_string(),
    })
}

fn server_error(e: sqlx::Error, ctx: &str) -> HttpResponse {
    log::error!("sprites: {ctx}: {e:?}");
    HttpResponse::InternalServerError().json(ErrorResponse {
        error: format!("Failed to {ctx}"),
    })
}

/// Resolve the active sprite key — the saved selection, or the default.
async fn active_key(pool: &DbPool) -> String {
    store::get(pool, ACTIVE_KEY)
        .await
        .unwrap_or_else(|| DEFAULT_KEY.to_string())
}

// ── PUBLIC: the active mascot (rendered pre-login on the loader/logo) ──

pub async fn get_active(pool: web::Data<DbPool>) -> impl Responder {
    let key = active_key(pool.get_ref()).await;
    // Prefer the selected sprite; fall back to any row so a deleted/missing
    // selection still yields something renderable.
    let row = sqlx::query_as::<_, SpriteRow>(
        "SELECT key, name, definition, is_builtin FROM sprites WHERE key = $1",
    )
    .bind(&key)
    .fetch_optional(pool.get_ref())
    .await;

    let row = match row {
        Ok(Some(r)) => Some(r),
        Ok(None) => sqlx::query_as::<_, SpriteRow>(
            "SELECT key, name, definition, is_builtin FROM sprites \
             ORDER BY is_builtin DESC, name LIMIT 1",
        )
        .fetch_optional(pool.get_ref())
        .await
        .ok()
        .flatten(),
        Err(e) => return server_error(e, "load active sprite"),
    };

    match row {
        Some(r) => HttpResponse::Ok().json(ActiveSpriteResponse {
            key: r.key,
            name: r.name,
            definition: r.definition,
        }),
        None => HttpResponse::NotFound().json(ErrorResponse {
            error: "No sprites configured".to_string(),
        }),
    }
}

// ── Admin: list ──

pub async fn list_sprites(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let active = active_key(pool.get_ref()).await;
    let rows = sqlx::query_as::<_, SpriteRow>(
        "SELECT key, name, definition, is_builtin FROM sprites ORDER BY is_builtin DESC, name",
    )
    .fetch_all(pool.get_ref())
    .await;

    match rows {
        Ok(rows) => {
            let out: Vec<SpriteResponse> = rows
                .into_iter()
                .map(|r| SpriteResponse {
                    active: r.key == active,
                    key: r.key,
                    name: r.name,
                    definition: r.definition,
                    is_builtin: r.is_builtin,
                })
                .collect();
            HttpResponse::Ok().json(out)
        }
        Err(e) => server_error(e, "list sprites"),
    }
}

// ── Admin: create ──

pub async fn create_sprite(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<CreateSpriteRequest>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let req = body.into_inner();
    let key = req.key.trim().to_lowercase();
    if key.is_empty() || !key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "key must be a non-empty slug (a-z, 0-9, -, _)".to_string(),
        });
    }
    if let Err(e) = req.definition.validate() {
        return HttpResponse::BadRequest().json(ErrorResponse { error: e });
    }
    let definition = match serde_json::to_value(&req.definition) {
        Ok(v) => v,
        Err(e) => {
            return HttpResponse::BadRequest().json(ErrorResponse {
                error: format!("invalid definition: {e}"),
            })
        }
    };

    let res = sqlx::query(
        "INSERT INTO sprites (key, name, definition, is_builtin) VALUES ($1, $2, $3, FALSE)",
    )
    .bind(&key)
    .bind(req.name.trim())
    .bind(&definition)
    .execute(pool.get_ref())
    .await;

    match res {
        Ok(_) => HttpResponse::Ok().json(SpriteResponse {
            key,
            name: req.name.trim().to_string(),
            definition,
            is_builtin: false,
            active: false,
        }),
        Err(sqlx::Error::Database(db)) if db.is_unique_violation() => {
            HttpResponse::Conflict().json(ErrorResponse {
                error: "a sprite with that key already exists".to_string(),
            })
        }
        Err(e) => server_error(e, "create sprite"),
    }
}

// ── Admin: update ──

pub async fn update_sprite(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<String>,
    body: web::Json<UpdateSpriteRequest>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let key = path.into_inner();
    let req = body.into_inner();

    if let Some(def) = &req.definition {
        if let Err(e) = def.validate() {
            return HttpResponse::BadRequest().json(ErrorResponse { error: e });
        }
    }

    let existing = sqlx::query_as::<_, SpriteRow>(
        "SELECT key, name, definition, is_builtin FROM sprites WHERE key = $1",
    )
    .bind(&key)
    .fetch_optional(pool.get_ref())
    .await;
    let existing = match existing {
        Ok(Some(r)) => r,
        Ok(None) => {
            return HttpResponse::NotFound().json(ErrorResponse {
                error: "sprite not found".to_string(),
            })
        }
        Err(e) => return server_error(e, "load sprite"),
    };

    let name = req.name.unwrap_or(existing.name);
    let definition = match req.definition {
        Some(def) => serde_json::to_value(&def).unwrap_or(existing.definition),
        None => existing.definition,
    };

    let res = sqlx::query(
        "UPDATE sprites SET name = $2, definition = $3, updated_at = NOW() WHERE key = $1",
    )
    .bind(&key)
    .bind(name.trim())
    .bind(&definition)
    .execute(pool.get_ref())
    .await;

    match res {
        Ok(_) => {
            let active = active_key(pool.get_ref()).await;
            HttpResponse::Ok().json(SpriteResponse {
                active: key == active,
                key,
                name: name.trim().to_string(),
                definition,
                is_builtin: existing.is_builtin,
            })
        }
        Err(e) => server_error(e, "update sprite"),
    }
}

// ── Admin: delete ──

pub async fn delete_sprite(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<String>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let key = path.into_inner();
    if key == active_key(pool.get_ref()).await {
        return HttpResponse::BadRequest().json(ErrorResponse {
            error: "cannot delete the active sprite — switch the active mascot first".to_string(),
        });
    }
    let res = sqlx::query("DELETE FROM sprites WHERE key = $1")
        .bind(&key)
        .execute(pool.get_ref())
        .await;
    match res {
        Ok(r) if r.rows_affected() == 0 => HttpResponse::NotFound().json(ErrorResponse {
            error: "sprite not found".to_string(),
        }),
        Ok(_) => HttpResponse::Ok().json(serde_json::json!({ "deleted": key })),
        Err(e) => server_error(e, "delete sprite"),
    }
}

// ── Admin: set active ──

pub async fn set_active(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<SetActiveRequest>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let key = body.into_inner().key;
    let exists = sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM sprites WHERE key = $1)")
        .bind(&key)
        .fetch_one(pool.get_ref())
        .await;
    match exists {
        Ok(true) => {}
        Ok(false) => {
            return HttpResponse::NotFound().json(ErrorResponse {
                error: "sprite not found".to_string(),
            })
        }
        Err(e) => return server_error(e, "check sprite"),
    }
    if let Err(e) = store::set(pool.get_ref(), ACTIVE_KEY, &key).await {
        return server_error(e, "set active sprite");
    }
    HttpResponse::Ok().json(serde_json::json!({ "key": key }))
}

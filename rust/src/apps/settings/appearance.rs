//! Appearance — the active UI theme, global for the vault (single-tenant).
//!
//! Reading is public: the login screen and public share pages render before any
//! auth and should already wear the vault's theme. A theme id is not sensitive.
//! Writing needs `admin_access`. The theme list itself lives in the frontend
//! (src/theme/tokens.json); here we only check the id's shape.

use actix_web::{web, HttpResponse, Responder};

use super::models::{AppearanceConfig, UpdateAppearance};
use super::store;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

fn valid_theme_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 32
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// GET /settings/appearance — public.
pub async fn get_appearance(pool: web::Data<DbPool>) -> impl Responder {
    let theme = store::get(pool.get_ref(), store::UI_THEME).await;
    HttpResponse::Ok().json(AppearanceConfig { theme })
}

/// PUT /admin/settings/appearance — set the active theme id.
pub async fn update_appearance(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<UpdateAppearance>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return HttpResponse::Forbidden()
            .json(serde_json::json!({ "error": "admin_access required" }));
    }
    let theme = body.into_inner().theme;
    if !valid_theme_id(&theme) {
        return HttpResponse::BadRequest()
            .json(serde_json::json!({ "error": "theme must be 1-32 chars of a-z, 0-9, -" }));
    }
    if let Err(e) = store::set(pool.get_ref(), store::UI_THEME, &theme).await {
        log::error!("save ui_theme: {e}");
        return HttpResponse::InternalServerError()
            .json(serde_json::json!({ "error": "could not save the theme" }));
    }
    HttpResponse::Ok().json(AppearanceConfig { theme: Some(theme) })
}

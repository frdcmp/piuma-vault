use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/health", web::get().to(handlers::hello))
        .route("/health/list", web::get().to(handlers::get_healths))
        .route("/health", web::post().to(handlers::create_health))
        .route("/health/{id}", web::get().to(handlers::get_health))
        .route("/health/{id}", web::put().to(handlers::update_health))
        .route("/health/{id}", web::delete().to(handlers::delete_health));
}

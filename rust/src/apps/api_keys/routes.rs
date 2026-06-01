use super::handlers;
use actix_web::web;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/admin/api-keys")
            .route("", web::get().to(handlers::list_api_keys))
            .route("", web::post().to(handlers::create_api_key))
            .route("/{id}", web::get().to(handlers::get_api_key))
            .route("/{id}", web::put().to(handlers::update_api_key))
            .route("/{id}", web::delete().to(handlers::delete_api_key))
            .route("/{id}/revoke", web::post().to(handlers::revoke_api_key)),
    );
}
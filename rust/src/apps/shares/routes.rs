use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // Admin endpoints
        .service(
            web::resource("/admin/notes/{id}/share")
                .route(web::post().to(handlers::create_share)),
        )
        .service(
            web::resource("/admin/notes/{id}/shares")
                .route(web::get().to(handlers::list_shares)),
        )
        .service(
            web::resource("/admin/notes/shares/{shareId}")
                .route(web::put().to(handlers::update_share))
                .route(web::delete().to(handlers::delete_share)),
        )
        // Public endpoints
        .service(
            web::resource("/share/v/{slug}")
                .route(web::get().to(handlers::get_shared_note))
                .route(web::put().to(handlers::update_shared_note)),
        );
}

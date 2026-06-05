use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // ── Buckets ──
        .service(
            web::resource("/admin/buckets")
                .route(web::get().to(handlers::list_buckets))
                .route(web::post().to(handlers::create_bucket)),
        )
        .service(
            web::resource("/admin/buckets/{id}")
                .route(web::put().to(handlers::update_bucket))
                .route(web::delete().to(handlers::delete_bucket)),
        )
        // ── Tags ──
        // "/tree" before "/{id}" so it isn't parsed as a tag id.
        .service(web::resource("/admin/tags/tree").route(web::get().to(handlers::get_tree)))
        .service(
            web::resource("/admin/tags")
                .route(web::get().to(handlers::list_tags))
                .route(web::post().to(handlers::create_tag)),
        )
        .service(
            web::resource("/admin/tags/{id}")
                .route(web::put().to(handlers::update_tag))
                .route(web::delete().to(handlers::delete_tag)),
        );
}

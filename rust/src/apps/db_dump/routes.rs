use super::handlers;
use actix_web::web;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/admin/db-dump/list", web::get().to(handlers::list_dumps))
        .route("/admin/db-dump/create", web::post().to(handlers::create_dump))
        .route(
            "/admin/db-dump/download",
            web::post().to(handlers::download_dump),
        )
        .route("/admin/db-dump/delete", web::post().to(handlers::delete_dump))
        .route(
            "/admin/db-dump/restore",
            web::post().to(handlers::restore_dump),
        );
}

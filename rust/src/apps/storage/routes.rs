use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/storage", web::get().to(handlers::hello))
        .route("/storage/list", web::get().to(handlers::list))
        .route(
            "/storage/presign-upload",
            web::post().to(handlers::presign_upload),
        )
        .route(
            "/storage/object/{key:.*}",
            web::delete().to(handlers::delete_object),
        )
        .route("/storage/folder", web::delete().to(handlers::delete_folder))
        .route(
            "/storage/bulk/delete",
            web::post().to(handlers::bulk_delete),
        )
        .route("/storage/bulk/move", web::post().to(handlers::bulk_move))
        .route("/storage/zip", web::post().to(handlers::zip_bundle))
        .route(
            "/storage/signed-url",
            web::post().to(handlers::signed_url),
        )
        .route(
            "/storage/app-update-manifest",
            web::get().to(handlers::app_update_manifest),
        );
}

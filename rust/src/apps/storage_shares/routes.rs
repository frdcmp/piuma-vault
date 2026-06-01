use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // Admin (auth + storage.access)
        .service(
            web::resource("/admin/storage/shares")
                .route(web::post().to(handlers::create_share))
                .route(web::get().to(handlers::list_shares)),
        )
        .service(
            web::resource("/admin/storage/shares/{id}")
                .route(web::put().to(handlers::update_share))
                .route(web::delete().to(handlers::delete_share)),
        )
        // Public (slug-based, no auth)
        .service(web::resource("/share/f/{slug}").route(web::get().to(handlers::meta)))
        .service(web::resource("/share/f/{slug}/list").route(web::get().to(handlers::list)))
        .service(
            web::resource("/share/f/{slug}/signed-url").route(web::post().to(handlers::signed_url)),
        )
        .service(web::resource("/share/f/{slug}/zip").route(web::post().to(handlers::zip)))
        .service(
            web::resource("/share/f/{slug}/upload")
                .route(web::post().to(handlers::presign_upload)),
        )
        .service(
            web::resource("/share/f/{slug}/object")
                .route(web::delete().to(handlers::delete_object)),
        )
        .service(
            web::resource("/share/f/{slug}/folder")
                .route(web::post().to(handlers::create_folder))
                .route(web::delete().to(handlers::delete_folder)),
        )
        .service(web::resource("/share/f/{slug}/move").route(web::post().to(handlers::move_item)));
}

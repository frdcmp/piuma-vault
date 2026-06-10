use actix_web::web;

use super::{handlers, screen_lock};

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/admin/settings/screen-lock")
            .route(web::get().to(screen_lock::get_screen_lock))
            .route(web::put().to(screen_lock::update_screen_lock)),
    )
    .service(
        web::resource("/admin/settings/screen-lock/verify")
            .route(web::post().to(screen_lock::verify_screen_lock)),
    )
    .service(
        web::resource("/admin/settings/services")
            .route(web::get().to(handlers::get_services))
            .route(web::put().to(handlers::update_services)),
    )
    .service(
        web::resource("/admin/settings/services/test/embedding")
            .route(web::post().to(handlers::test_embedding)),
    )
    .service(
        web::resource("/admin/settings/services/test/storage")
            .route(web::post().to(handlers::test_storage)),
    )
    .service(
        web::resource("/admin/settings/services/test/websearch")
            .route(web::post().to(handlers::test_websearch)),
    )
    .service(
        web::resource("/admin/settings/services/test/github")
            .route(web::post().to(handlers::test_github)),
    );
}

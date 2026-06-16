use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/images/generate").route(web::post().to(handlers::generate)))
        .service(web::resource("/images").route(web::get().to(handlers::list_images)))
        .service(
            web::resource("/images/{id}")
                .route(web::get().to(handlers::get_image))
                .route(web::delete().to(handlers::delete_image)),
        );
}

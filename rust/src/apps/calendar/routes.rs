use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/admin/calendar/events")
            .route(web::get().to(handlers::list_events))
            .route(web::post().to(handlers::create_event)),
    )
    .service(
        web::resource("/admin/calendar/events/{id}")
            .route(web::get().to(handlers::get_event))
            .route(web::put().to(handlers::update_event))
            .route(web::delete().to(handlers::delete_event)),
    );
}

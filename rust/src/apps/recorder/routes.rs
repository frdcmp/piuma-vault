use actix_web::web;

use super::{handlers, ws};

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/recorder/usage").route(web::get().to(handlers::usage)))
        .service(
            web::resource("/recorder/sessions")
                .route(web::get().to(handlers::list_sessions))
                .route(web::post().to(handlers::create_session)),
        )
    // WS upgrade — registered before `/sessions/{id}` so "ws" isn't read as part
    // of the id path.
    .service(
        web::resource("/recorder/sessions/{id}/ws").route(web::get().to(ws::ws_handler)),
    )
    .service(
        web::resource("/recorder/sessions/{id}/transcript")
            .route(web::get().to(handlers::get_transcript)),
    )
    .service(
        web::resource("/recorder/sessions/{id}/stop").route(web::post().to(handlers::stop_session)),
    )
    .service(
        web::resource("/recorder/sessions/{id}/title").route(web::post().to(handlers::set_title)),
    )
    .service(
        web::resource("/recorder/sessions/{id}")
            .route(web::get().to(handlers::get_session))
            .route(web::delete().to(handlers::delete_session)),
    );
}

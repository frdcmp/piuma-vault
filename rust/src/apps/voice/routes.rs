use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/agents/voice/sessions").route(web::post().to(handlers::start_session)))
        .service(web::resource("/agents/voice/tool").route(web::post().to(handlers::run_tool)))
        .service(web::resource("/agents/voice/turns").route(web::post().to(handlers::save_turn)));
}

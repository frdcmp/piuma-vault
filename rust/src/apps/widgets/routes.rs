use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/widgets/summary").route(web::get().to(handlers::summary)));
}

use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(web::resource("/admin/agenda").route(web::get().to(handlers::get_agenda)));
}

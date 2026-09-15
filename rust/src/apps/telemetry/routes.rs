use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.route("/telemetry/client", web::post().to(handlers::ingest));
}

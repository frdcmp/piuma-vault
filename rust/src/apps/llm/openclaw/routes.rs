use actix_web::web;
use super::handlers;

pub fn configure(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/llm/openclaw/chat")
            .route(web::post().to(handlers::openclaw_chat)),
    );
}

use actix_web::web;
use crate::apps::llm::openclaw::handlers as openclaw_handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/llm/openclaw/chat")
            .route(web::post().to(openclaw_handlers::openclaw_chat)),
    );
}

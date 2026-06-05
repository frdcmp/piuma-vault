use actix_web::web;

use super::handlers;

// Route paths stay `/llm/openclaw/*` (unchanged) — only the module moved out of
// the old `apps/llm` wrapper into its own top-level `apps/openclaw`.
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/llm/openclaw/chat")
            .route(web::post().to(handlers::openclaw_chat)),
    );
    cfg.service(
        web::resource("/llm/openclaw/history")
            .route(web::get().to(handlers::openclaw_history)),
    );
}

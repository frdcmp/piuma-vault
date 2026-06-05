use actix_web::web;

use super::handlers;

// Routes now live under `/openclaw/*` (migrated out of the old `/llm/*`
// namespace along with the module). The old `/llm/openclaw/*` clients are gone.
pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/openclaw/chat").route(web::post().to(handlers::openclaw_chat)),
    );
    cfg.service(
        web::resource("/openclaw/history").route(web::get().to(handlers::openclaw_history)),
    );
}

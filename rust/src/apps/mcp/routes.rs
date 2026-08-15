use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/admin/mcp/servers")
            .route(web::get().to(handlers::list_servers))
            .route(web::post().to(handlers::create_server)),
    )
    // Specific paths before the `{id}` catch-all.
    .service(web::resource("/admin/mcp/health").route(web::get().to(handlers::worker_health)))
    .service(
        web::resource("/admin/mcp/servers/{id}/test").route(web::post().to(handlers::test_server)),
    )
    .service(
        web::resource("/admin/mcp/servers/{id}")
            .route(web::put().to(handlers::update_server))
            .route(web::delete().to(handlers::delete_server)),
    );
}

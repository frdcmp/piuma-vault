use super::handlers;
use actix_web::web;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    // Public: the active mascot, rendered pre-login on the loader/logo.
    cfg.service(web::resource("/sprites/active").route(web::get().to(handlers::get_active)));

    // Admin CRUD + active selection.
    cfg.service(
        web::scope("/admin/sprites")
            .route("", web::get().to(handlers::list_sprites))
            .route("", web::post().to(handlers::create_sprite))
            .route("/active", web::put().to(handlers::set_active))
            .route("/{key}", web::put().to(handlers::update_sprite))
            .route("/{key}", web::delete().to(handlers::delete_sprite)),
    );
}

use super::events::Sprites;
use super::handlers;
use crate::apps::realtime::event_stream;
use actix_web::web;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    // Public: the active mascot, rendered pre-login on the loader/logo.
    cfg.service(web::resource("/sprites/active").route(web::get().to(handlers::get_active)));

    // Admin CRUD + active selection.
    cfg.service(
        web::scope("/admin/sprites")
            .route("", web::get().to(handlers::list_sprites))
            .route("", web::post().to(handlers::create_sprite))
            .route("/generate", web::post().to(handlers::generate_sprite))
            // Live updates — a freshly AI-generated sprite is broadcast here.
            .route("/events", web::get().to(event_stream::<Sprites>))
            .route("/active", web::put().to(handlers::set_active))
            .route("/{key}", web::put().to(handlers::update_sprite))
            .route("/{key}", web::delete().to(handlers::delete_sprite)),
    );
}

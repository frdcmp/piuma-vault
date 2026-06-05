use actix_web::web;

use super::{chat, handlers};

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // Agents listing
        .service(web::resource("/agents").route(web::get().to(handlers::list_agents)))
        // Providers
        .service(
            web::resource("/agents/providers")
                .route(web::get().to(handlers::list_providers))
                .route(web::post().to(handlers::create_provider)),
        )
        .service(
            web::resource("/agents/providers/{id}")
                .route(web::patch().to(handlers::update_provider))
                .route(web::delete().to(handlers::delete_provider)),
        )
        .service(
            web::resource("/agents/providers/{id}/models")
                .route(web::get().to(handlers::list_models))
                .route(web::post().to(handlers::create_model)),
        )
        // Models
        .service(
            web::resource("/agents/models/{id}")
                .route(web::patch().to(handlers::update_model))
                .route(web::delete().to(handlers::delete_model)),
        )
        // Personas (by id)
        .service(
            web::resource("/agents/personas/{id}")
                .route(web::patch().to(handlers::patch_persona)),
        )
        // Conversations
        .service(
            web::resource("/agents/conversations")
                .route(web::get().to(handlers::list_conversations))
                .route(web::post().to(handlers::create_conversation)),
        )
        .service(
            web::resource("/agents/conversations/{id}")
                .route(web::get().to(handlers::get_conversation))
                .route(web::patch().to(handlers::update_conversation))
                .route(web::delete().to(handlers::delete_conversation)),
        )
        .service(
            web::resource("/agents/conversations/{id}/chat")
                .route(web::post().to(chat::chat)),
        )
        // Agent config (profile + personas) — registered last so the static
        // segments above win over the `{agent}` wildcard.
        .service(
            web::resource("/agents/{agent}/profile")
                .route(web::get().to(handlers::get_profile))
                .route(web::patch().to(handlers::patch_profile)),
        )
        .service(
            web::resource("/agents/{agent}/personas")
                .route(web::get().to(handlers::list_personas)),
        );
}

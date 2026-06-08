use actix_web::web;

use super::{chat, handlers, memory_admin};

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // Agents listing
        .service(web::resource("/agents").route(web::get().to(handlers::list_agents)))
        // Memory dashboard (admin) — static segments, registered before the
        // `/agents/{agent}` wildcard further down.
        .service(web::resource("/agents/memory/overview").route(web::get().to(memory_admin::overview)))
        .service(web::resource("/agents/memory/entries").route(web::get().to(memory_admin::list_entries)))
        .service(web::resource("/agents/memory/turn-logs").route(web::get().to(memory_admin::turn_logs)))
        .service(web::resource("/agents/memory/conversations").route(web::get().to(memory_admin::search_conversations)))
        .service(
            web::resource("/agents/memory/entries/{id}/confirm")
                .route(web::post().to(memory_admin::confirm_entry)),
        )
        .service(
            web::resource("/agents/memory/entries/{id}/reject")
                .route(web::post().to(memory_admin::reject_entry)),
        )
        .service(
            web::resource("/agents/memory/entries/{id}")
                .route(web::delete().to(memory_admin::delete_entry)),
        )
        .service(
            web::resource("/agents/default-agent")
                .route(web::get().to(handlers::get_default_agent))
                .route(web::put().to(handlers::set_default_agent)),
        )
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
        .service(web::resource("/agents/models").route(web::get().to(handlers::list_all_models)))
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
        // STOP — cancel the running turn mid-stream.
        .service(
            web::resource("/agents/conversations/{id}/stop")
                .route(web::post().to(chat::stop)),
        )
        // INJECT — queue a message into the running turn (no new stream).
        .service(
            web::resource("/agents/conversations/{id}/inject")
                .route(web::post().to(chat::inject)),
        )
        .service(
            web::resource("/agents/conversations/{id}/messages")
                .route(web::delete().to(handlers::clear_conversation)),
        )
        .service(
            web::resource("/agents/conversations/{id}/retitle")
                .route(web::post().to(handlers::retitle_conversation)),
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

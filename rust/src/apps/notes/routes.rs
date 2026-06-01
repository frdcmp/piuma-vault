use actix_web::web;

use super::{events, handlers};

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        .service(
            web::resource("/admin/notes/events")
                .route(web::get().to(events::notes_event_stream)),
        )
        .service(
            web::resource("/admin/notes/tags")
                .route(web::get().to(handlers::list_tags)),
        )
        .service(
            web::resource("/admin/notes/folders")
                .route(web::get().to(handlers::list_folders)),
        )
        .service(
            web::resource("/admin/notes/folders/search")
                .route(web::get().to(handlers::search_folders)),
        )
        .service(
            web::resource("/admin/notes/folders/rename")
                .route(web::put().to(handlers::rename_folder)),
        )
        .service(
            web::resource("/admin/notes/browse")
                .route(web::get().to(handlers::browse_folder)),
        )
        // Trash: list soft-deleted notes / permanently empty them. Registered
        // before `/admin/notes/{id}` so "trash" isn't captured as an id.
        .service(
            web::resource("/admin/notes/trash")
                .route(web::get().to(handlers::list_trash))
                .route(web::delete().to(handlers::empty_trash)),
        )
        .service(
            web::resource("/admin/notes")
                .route(web::get().to(handlers::list_notes))
                .route(web::post().to(handlers::create_note)),
        )
        .service(
            web::resource("/admin/notes/{id}/restore")
                .route(web::put().to(handlers::restore_note)),
        )
        .service(
            web::resource("/admin/notes/{id}/permanent")
                .route(web::delete().to(handlers::permanently_delete_note)),
        )
        .service(
            web::resource("/admin/notes/{id}")
                .route(web::get().to(handlers::get_note))
                .route(web::put().to(handlers::update_note))
                .route(web::delete().to(handlers::delete_note)),
        );
}

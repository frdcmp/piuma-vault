use actix_web::web;

use crate::apps::realtime::event_stream;

use super::events::CalendarEvents;
use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    // Live updates (SSE). Named `/stream` rather than `/events` because the
    // calendar's own resource is already `/admin/calendar/events`.
    cfg.service(
        web::resource("/admin/calendar/stream").route(web::get().to(event_stream::<CalendarEvents>)),
    )
    .service(
        web::resource("/admin/calendar/events")
            .route(web::get().to(handlers::list_events))
            .route(web::post().to(handlers::create_event)),
    )
    .service(
        web::resource("/admin/calendar/events/{id}")
            .route(web::get().to(handlers::get_event))
            .route(web::put().to(handlers::update_event))
            .route(web::delete().to(handlers::delete_event)),
    );
}

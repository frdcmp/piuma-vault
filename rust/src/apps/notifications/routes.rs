use actix_web::web;

use super::events::Notifications;
use super::handlers;
use crate::apps::realtime::event_stream;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/admin/notifications/web-push/subscribe")
            .route(web::post().to(handlers::subscribe_web_push))
            .route(web::delete().to(handlers::unsubscribe_web_push)),
    )
    .service(
        web::resource("/admin/notifications/vapid-public-key")
            .route(web::get().to(handlers::vapid_public_key)),
    )
    .service(
        web::resource("/admin/notifications/expo-token")
            .route(web::post().to(handlers::register_expo_token))
            .route(web::delete().to(handlers::delete_expo_token)),
    )
    .service(
        web::resource("/admin/notifications/preferences")
            .route(web::get().to(handlers::get_preferences))
            .route(web::put().to(handlers::update_preferences)),
    )
    .service(
        web::resource("/admin/notifications/test")
            .route(web::post().to(handlers::test_notification)),
    )
    .service(
        web::resource("/admin/notifications/upcoming")
            .route(web::get().to(handlers::get_upcoming)),
    )
    // ── In-app notification center (inbox) ──
    // Note: register fixed sub-paths (unread-count, read-all) before the
    // `{id}` catch-all so they aren't swallowed by it.
    .service(
        web::resource("/admin/notifications/inbox")
            .route(web::get().to(handlers::list_inbox))
            .route(web::post().to(handlers::compose_notification)),
    )
    .service(
        web::resource("/admin/notifications/inbox/unread-count")
            .route(web::get().to(handlers::unread_count)),
    )
    .service(
        web::resource("/admin/notifications/inbox/read-all")
            .route(web::post().to(handlers::mark_all_read)),
    )
    .service(
        web::resource("/admin/notifications/inbox/{id}/read")
            .route(web::post().to(handlers::mark_read)),
    )
    .service(
        web::resource("/admin/notifications/inbox/{id}")
            .route(web::delete().to(handlers::dismiss_notification)),
    )
    // Live badge updates (same-process events; EventSource passes ?token=).
    .service(
        web::resource("/admin/notifications/events")
            .route(web::get().to(event_stream::<Notifications>)),
    );
}

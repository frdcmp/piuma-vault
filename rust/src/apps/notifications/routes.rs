use actix_web::web;

use super::handlers;

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
    );
}

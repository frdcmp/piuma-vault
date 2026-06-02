use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // ── Recurring-task templates ──
        .service(
            web::resource("/admin/recurring-tasks")
                .route(web::get().to(handlers::list_recurring))
                .route(web::post().to(handlers::create_recurring)),
        )
        .service(
            web::resource("/admin/recurring-tasks/{id}/occurrences/{date}/complete")
                .route(web::put().to(handlers::complete_occurrence)),
        )
        .service(
            web::resource("/admin/recurring-tasks/{id}")
                .route(web::get().to(handlers::get_recurring))
                .route(web::put().to(handlers::update_recurring))
                .route(web::delete().to(handlers::delete_recurring)),
        )
        // ── Tasks ──
        .service(
            web::resource("/admin/tasks")
                .route(web::get().to(handlers::list_tasks))
                .route(web::post().to(handlers::create_task)),
        )
        .service(
            web::resource("/admin/tasks/{id}/toggle")
                .route(web::put().to(handlers::toggle_task)),
        )
        .service(
            web::resource("/admin/tasks/{id}")
                .route(web::get().to(handlers::get_task))
                .route(web::put().to(handlers::update_task))
                .route(web::delete().to(handlers::delete_task)),
        );
}

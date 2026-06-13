use actix_web::web;

use crate::apps::realtime::event_stream;

use super::events::Cron;
use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg
        // SSE — registered before `/admin/cron/jobs/{id}` so "events" isn't an id.
        .service(web::resource("/admin/cron/events").route(web::get().to(event_stream::<Cron>)))
        .service(
            web::resource("/admin/cron/jobs")
                .route(web::get().to(handlers::list_jobs))
                .route(web::post().to(handlers::create_job)),
        )
        .service(
            web::resource("/admin/cron/jobs/{id}/run-now").route(web::post().to(handlers::run_now)),
        )
        .service(
            web::resource("/admin/cron/jobs/{id}/toggle").route(web::post().to(handlers::toggle_job)),
        )
        .service(
            web::resource("/admin/cron/jobs/{id}/runs").route(web::get().to(handlers::list_runs)),
        )
        .service(
            web::resource("/admin/cron/jobs/{id}")
                .route(web::get().to(handlers::get_job))
                .route(web::put().to(handlers::update_job))
                .route(web::delete().to(handlers::delete_job)),
        );
}

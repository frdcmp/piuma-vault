use actix_web::web;

use super::handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::resource("/admin/email/accounts")
            .route(web::get().to(handlers::list_accounts))
            .route(web::post().to(handlers::create_account)),
    )
    // Specific paths before the `{id}` catch-all.
    .service(
        web::resource("/admin/email/accounts/test/smtp")
            .route(web::post().to(handlers::test_smtp)),
    )
    .service(
        web::resource("/admin/email/accounts/test/imap")
            .route(web::post().to(handlers::test_imap)),
    )
    .service(
        web::resource("/admin/email/accounts/{id}/default")
            .route(web::post().to(handlers::set_default)),
    )
    .service(
        web::resource("/admin/email/accounts/{id}")
            .route(web::put().to(handlers::update_account))
            .route(web::delete().to(handlers::delete_account)),
    );
}

use actix_web::web;
use super::handlers;
use super::otp_handlers;

pub fn configure_routes(cfg: &mut web::ServiceConfig) {
    cfg.service(
        web::scope("/auth")
            .route("/register", web::post().to(handlers::register))
            .route("/login", web::post().to(handlers::login))
            .route("/login/otp", web::post().to(otp_handlers::login_otp))
            .route("/refresh", web::post().to(handlers::refresh_token))
            .route("/me", web::get().to(handlers::get_me))
            .route("/profile", web::put().to(handlers::update_profile))
            .route("/request-password-reset", web::post().to(handlers::request_password_reset))
            .route("/reset-password", web::post().to(handlers::reset_password))
            .route("/verify", web::get().to(handlers::verify_email))
            .route("/resend-verification", web::post().to(handlers::resend_verification))
            .route("/otp/setup", web::post().to(otp_handlers::otp_setup))
            .route("/otp/verify-setup", web::post().to(otp_handlers::otp_verify_setup))
            .route("/otp/disable", web::post().to(otp_handlers::otp_disable))
            .route("/devices", web::get().to(otp_handlers::list_trusted_devices))
            .route("/devices/{id}", web::delete().to(otp_handlers::revoke_trusted_device))
    );
}

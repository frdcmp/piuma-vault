//! Extractors that gate a handler before it runs. A handler takes one of these
//! instead of a bare `AuthenticatedUser`, so the check can't be forgotten on a
//! new route. Other apps build their own with [`gated`] (see `agents::access`).

use super::middleware::check_permission;
use super::models::AuthenticatedUser;
use actix_web::{dev::Payload, error::InternalError, FromRequest, HttpRequest, HttpResponse};
use std::future::Future;
use std::pin::Pin;

pub type GateFuture<T> = Pin<Box<dyn Future<Output = Result<T, actix_web::Error>>>>;

fn forbidden(msg: String) -> actix_web::Error {
    InternalError::from_response(msg.clone(), HttpResponse::Forbidden().json(serde_json::json!({ "error": msg })))
        .into()
}

/// Authenticate the caller, then let it through only if it holds `perm` (or
/// `admin_access`, which every account JWT carries).
pub fn gated<T: 'static>(
    req: &HttpRequest,
    payload: &mut Payload,
    perm: &'static str,
    wrap: fn(AuthenticatedUser) -> T,
) -> GateFuture<T> {
    let user = AuthenticatedUser::from_request(req, payload);
    Box::pin(async move {
        let user = user.await?;
        if check_permission(&user, perm) {
            Ok(wrap(user))
        } else {
            Err(forbidden(format!("Access denied: {perm} permission required")))
        }
    })
}

/// The account itself: 2FA, trusted devices, profile. Signed-in sessions only —
/// no API key reaches these, whatever its scopes, so a leaked key can't lock the
/// owner out of their own account.
pub struct AccountUser(pub AuthenticatedUser);

impl FromRequest for AccountUser {
    type Error = actix_web::Error;
    type Future = GateFuture<Self>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        let user = AuthenticatedUser::from_request(req, payload);
        Box::pin(async move {
            let user = user.await?;
            if user.via_api_key {
                Err(forbidden("Access denied: sign in to manage the account".to_string()))
            } else {
                Ok(AccountUser(user))
            }
        })
    }
}

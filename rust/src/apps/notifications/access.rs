//! Who may use `/admin/notifications/*`. An API key needs the scope named here:
//! the inbox can be read, written and cleared, and a push token registered here
//! receives every notification, so a key that reads tasks must not reach it.

use crate::apps::auth::access::{gated, GateFuture};
use crate::apps::auth::models::AuthenticatedUser;
use actix_web::{dev::Payload, FromRequest, HttpRequest};

/// Scope an API key needs for the notification inbox, preferences and push tokens.
pub const NOTIFICATIONS_SCOPE: &str = "notifications";

pub struct NotificationsUser(pub AuthenticatedUser);

impl FromRequest for NotificationsUser {
    type Error = actix_web::Error;
    type Future = GateFuture<Self>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, NOTIFICATIONS_SCOPE, NotificationsUser)
    }
}

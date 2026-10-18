//! Who may use the `/agents/*` API. Handlers take one of these instead of a bare
//! `AuthenticatedUser`, so the check runs in the extractor and can't be
//! forgotten on a new route.
//!
//! The account's JWT always carries `admin_access`, so the web and mobile apps
//! pass both. An API key passes only with the scope named here: a chat turn runs
//! the agent's tools (notes, tasks, calendar writes…), so even a key that is
//! read-only everywhere else must not reach it without `agents.chat`.

use super::models::ApiError;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use actix_web::{dev::Payload, error::InternalError, FromRequest, HttpRequest, HttpResponse};
use std::future::Future;
use std::pin::Pin;

/// Scope an API key needs to hold conversations and run chat turns.
pub const CHAT_SCOPE: &str = "agents.chat";

/// Conversations and chat turns: `agents.chat` (or `admin_access`).
pub struct AgentChat(pub AuthenticatedUser);

/// Providers, models, agent profiles, memory and usage: `admin_access` only.
#[allow(dead_code)] // no admin handler reads the caller yet
pub struct AgentAdmin(pub AuthenticatedUser);

fn forbidden(perm: &str) -> actix_web::Error {
    let msg = format!("Access denied: {perm} permission required");
    InternalError::from_response(msg.clone(), HttpResponse::Forbidden().json(ApiError::new(msg))).into()
}

fn gated<T: 'static>(
    req: &HttpRequest,
    payload: &mut Payload,
    perm: &'static str,
    wrap: fn(AuthenticatedUser) -> T,
) -> Pin<Box<dyn Future<Output = Result<T, actix_web::Error>>>> {
    let user = AuthenticatedUser::from_request(req, payload);
    Box::pin(async move {
        let user = user.await?;
        if check_permission(&user, perm) {
            Ok(wrap(user))
        } else {
            Err(forbidden(perm))
        }
    })
}

impl FromRequest for AgentChat {
    type Error = actix_web::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self, Self::Error>>>>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, CHAT_SCOPE, AgentChat)
    }
}

impl FromRequest for AgentAdmin {
    type Error = actix_web::Error;
    type Future = Pin<Box<dyn Future<Output = Result<Self, Self::Error>>>>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, "admin_access", AgentAdmin)
    }
}

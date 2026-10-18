//! Who may use the `/agents/*` API. Handlers take one of these instead of a bare
//! `AuthenticatedUser`, so the check runs in the extractor and can't be
//! forgotten on a new route.
//!
//! The account's JWT always carries `admin_access`, so the web and mobile apps
//! pass both. An API key passes only with the scope named here: a chat turn runs
//! the agent's tools (notes, tasks, calendar writes…), so even a key that is
//! read-only everywhere else must not reach it without `agents.chat`.

use crate::apps::auth::access::{gated, GateFuture};
use crate::apps::auth::models::AuthenticatedUser;
use actix_web::{dev::Payload, FromRequest, HttpRequest};

/// Scope an API key needs to hold conversations and run chat turns.
pub const CHAT_SCOPE: &str = "agents.chat";

/// Conversations and chat turns: `agents.chat` (or `admin_access`).
pub struct AgentChat(pub AuthenticatedUser);

/// Providers, models, agent profiles, memory and usage: `admin_access` only.
#[allow(dead_code)] // no admin handler reads the caller yet
pub struct AgentAdmin(pub AuthenticatedUser);

impl FromRequest for AgentChat {
    type Error = actix_web::Error;
    type Future = GateFuture<Self>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, CHAT_SCOPE, AgentChat)
    }
}

impl FromRequest for AgentAdmin {
    type Error = actix_web::Error;
    type Future = GateFuture<Self>;

    fn from_request(req: &HttpRequest, payload: &mut Payload) -> Self::Future {
        gated(req, payload, "admin_access", AgentAdmin)
    }
}

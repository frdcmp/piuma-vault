//! Live-update bus for sprites. See `apps::realtime` for the generic machinery.
//! The SSE endpoint is registered in `routes.rs`; the async AI-generation worker
//! publishes here once a freshly-generated sprite lands in the DB, so connected
//! admins see it appear without a manual refresh.

use crate::apps::realtime::{Resource, ResourceEventBus};

pub struct Sprites;

impl Resource for Sprites {
    const EVENT: &'static str = "sprite";
}

pub type SpritesEventBus = ResourceEventBus<Sprites>;

//! Live-update bus for calendar events. See `apps::realtime` for the generic
//! machinery. The SSE endpoint is registered in `routes.rs`; mutating handlers
//! publish here on success.

use crate::apps::realtime::{Resource, ResourceEventBus};

pub struct CalendarEvents;

impl Resource for CalendarEvents {
    const EVENT: &'static str = "event";
}

pub type CalendarEventBus = ResourceEventBus<CalendarEvents>;

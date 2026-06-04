//! Live-update bus for tasks (one-off + recurring + occurrences). See
//! `apps::realtime` for the generic machinery. The SSE endpoint is registered
//! in `routes.rs`; mutating handlers publish here on success.

use crate::apps::realtime::{Resource, ResourceEventBus};

pub struct Tasks;

impl Resource for Tasks {
    const EVENT: &'static str = "task";
}

pub type TasksEventBus = ResourceEventBus<Tasks>;

//! Live-update bus for cron jobs/runs. See `apps::realtime` for the generic
//! machinery; the SSE endpoint is registered in `routes.rs`. The cron-worker and
//! the CRUD handlers publish here so an open admin page refreshes run history
//! without polling.

use crate::apps::realtime::{Resource, ResourceEventBus};

pub struct Cron;

impl Resource for Cron {
    const EVENT: &'static str = "cron";
}

pub type CronEventBus = ResourceEventBus<Cron>;

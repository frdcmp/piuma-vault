//! Scheduled autonomous agent jobs ("cron"). A job is an instruction + an
//! RRULE/once schedule; the `cron-worker` binary fires due jobs through the
//! headless `agents::runner`, posts the result into a per-job conversation, and
//! notifies the owner. This module owns the admin CRUD/control API + the live bus.

pub mod events;
pub mod handlers;
pub mod models;
pub mod routes;

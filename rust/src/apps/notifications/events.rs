//! Live-update bus for the in-app notification center. See `apps::realtime` for
//! the generic machinery; the SSE endpoint is registered in `routes.rs`. The
//! HTTP server's handlers (e.g. manual compose) publish here so an open client's
//! bell badge updates instantly.
//!
//! NOTE: the broadcast bus is in-process. The notification-/cron-workers run as
//! separate binaries, so they cannot publish to the HTTP server's subscribers —
//! notifications they create surface on the client's next refetch (the bell's
//! unread-count query refetches on focus + interval). The SSE stream is a
//! best-effort live hint for same-process events.

use crate::apps::realtime::{Resource, ResourceEventBus};

pub struct Notifications;

impl Resource for Notifications {
    const EVENT: &'static str = "notification";
}

pub type NotificationsEventBus = ResourceEventBus<Notifications>;

//! `notify()` — the single entry point for creating a user-facing notification.
//!
//! It (1) writes the persisted inbox row (the source of truth for the header
//! bell), (2) publishes a live SSE hint when a bus is supplied (HTTP server
//! only — see `events.rs`), and (3) optionally fans out to the push channels
//! (Web Push + Expo), honoring the user's per-channel preferences.
//!
//! Any feature can "send a message" by calling this — manual compose, cron job
//! reports, task/event alerts, etc. The caller picks channels per message.

use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::apps::realtime::ResourceAction;
use crate::db::db::DbPool;

use super::events::NotificationsEventBus;
use super::{expo, webpush};

/// A notification to create. `group_key`, when set, coalesces repeats of the
/// same source (e.g. a recurring reminder) into one unread row instead of
/// stacking duplicates — see [`notify`].
#[derive(Debug, Clone)]
pub struct NewNotification {
    pub user_id: String,
    pub category: String,
    pub level: String,
    pub title: String,
    pub body: Option<String>,
    pub action_url: Option<String>,
    pub metadata: serde_json::Value,
    pub group_key: Option<String>,
}

impl NewNotification {
    /// Minimal constructor; fill optional fields with the builder-ish setters.
    pub fn new(
        user_id: impl Into<String>,
        category: impl Into<String>,
        title: impl Into<String>,
    ) -> Self {
        Self {
            user_id: user_id.into(),
            category: category.into(),
            level: "info".to_string(),
            title: title.into(),
            body: None,
            action_url: None,
            metadata: json!({}),
            group_key: None,
        }
    }

    pub fn level(mut self, level: impl Into<String>) -> Self {
        self.level = level.into();
        self
    }
    pub fn body(mut self, body: impl Into<String>) -> Self {
        self.body = Some(body.into());
        self
    }
    pub fn action_url(mut self, url: impl Into<String>) -> Self {
        self.action_url = Some(url.into());
        self
    }
    pub fn metadata(mut self, metadata: serde_json::Value) -> Self {
        self.metadata = metadata;
        self
    }
    pub fn group_key(mut self, key: impl Into<String>) -> Self {
        self.group_key = Some(key.into());
        self
    }
}

/// Which delivery channels a notification should use. The inbox is the source
/// of truth; web/expo are optional push fan-out.
#[derive(Debug, Clone, Copy)]
pub struct Channels {
    pub inbox: bool,
    pub web_push: bool,
    pub expo: bool,
}

impl Channels {
    /// Inbox row only — no push (e.g. a quiet system log).
    pub fn inbox_only() -> Self {
        Self {
            inbox: true,
            web_push: false,
            expo: false,
        }
    }

    /// Inbox + both push channels.
    pub fn all() -> Self {
        Self {
            inbox: true,
            web_push: true,
            expo: true,
        }
    }

    /// Inbox always, plus push channels named in a `["web","push"]`-style list
    /// (the shape stored on alerts and cron jobs).
    pub fn from_list(list: &[String]) -> Self {
        Self {
            inbox: true,
            web_push: list.iter().any(|c| c == "web"),
            expo: list.iter().any(|c| c == "push"),
        }
    }
}

/// Outcome of [`notify`] — the row id and whether it was a fresh insert or a
/// coalesce into an existing unread row.
#[derive(Debug, Clone)]
pub struct NotifyResult {
    pub id: Uuid,
    pub action: ResourceAction,
}

/// Create a notification: persist the inbox row (with coalescing), publish a
/// live hint if a bus is given, and fan out to push channels per the user's
/// preferences. Push failures are logged, not propagated — the inbox row is the
/// durable record. Returns the row id when the inbox channel is on.
pub async fn notify(
    pool: &DbPool,
    bus: Option<&NotificationsEventBus>,
    n: NewNotification,
    ch: Channels,
) -> Option<NotifyResult> {
    let result = if ch.inbox {
        match upsert_inbox(pool, &n).await {
            Ok(r) => {
                if let Some(bus) = bus {
                    bus.publish(r.action.clone(), r.id);
                }
                Some(r)
            }
            Err(e) => {
                log::error!("notify: inbox upsert failed: {e}");
                None
            }
        }
    } else {
        None
    };

    if ch.web_push || ch.expo {
        let (web_enabled, push_enabled) = load_prefs(pool, &n.user_id).await;
        // Push payloads are size-limited (~4 KB) — truncate the body for the
        // push. The full body is preserved on the inbox row above.
        let body = {
            let full = n.body.clone().unwrap_or_default();
            if full.chars().count() > 240 {
                let head: String = full.chars().take(240).collect();
                format!("{head}…")
            } else {
                full
            }
        };
        let url = n.action_url.clone().unwrap_or_else(|| "/".to_string());
        let tag = n.group_key.clone().unwrap_or_else(|| {
            format!(
                "{}:{}",
                n.category,
                result.as_ref().map(|r| r.id).unwrap_or_default()
            )
        });

        if ch.web_push && web_enabled {
            let payload =
                json!({ "title": n.title, "body": body, "url": url, "tag": tag }).to_string();
            let _ = webpush::dispatch_web(pool, &n.user_id, &payload).await;
        }
        if ch.expo && push_enabled {
            let data = json!({
                "url": url,
                "tag": tag,
                "type": n.category,
                "metadata": n.metadata,
            });
            let _ = expo::dispatch_expo(pool, &n.user_id, &n.title, &body, &data).await;
        }
    }

    result
}

/// Coalesce into an existing unread, non-archived row sharing `(user_id,
/// group_key)`, else insert a fresh row. Without a `group_key`, always inserts.
async fn upsert_inbox(pool: &DbPool, n: &NewNotification) -> Result<NotifyResult, sqlx::Error> {
    if let Some(group_key) = &n.group_key {
        let existing: Option<Uuid> = sqlx::query_scalar(
            "UPDATE db_notifications \
                SET title = $3, body = $4, level = $5, action_url = $6, metadata = $7, \
                    count = count + 1, created_at = NOW() \
              WHERE user_id = $1 AND group_key = $2 \
                AND read_at IS NULL AND archived_at IS NULL \
              RETURNING id",
        )
        .bind(&n.user_id)
        .bind(group_key)
        .bind(&n.title)
        .bind(&n.body)
        .bind(&n.level)
        .bind(&n.action_url)
        .bind(&n.metadata)
        .fetch_optional(pool)
        .await?;

        if let Some(id) = existing {
            return Ok(NotifyResult {
                id,
                action: ResourceAction::Updated,
            });
        }
    }

    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_notifications \
            (user_id, category, level, title, body, action_url, metadata, group_key) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(&n.user_id)
    .bind(&n.category)
    .bind(&n.level)
    .bind(&n.title)
    .bind(&n.body)
    .bind(&n.action_url)
    .bind(&n.metadata)
    .bind(&n.group_key)
    .fetch_one(pool)
    .await?;

    Ok(NotifyResult {
        id,
        action: ResourceAction::Created,
    })
}

/// Per-user channel preferences (default both enabled when no row exists).
async fn load_prefs(pool: &DbPool, user_id: &str) -> (bool, bool) {
    sqlx::query_as::<_, (bool, bool)>(
        "SELECT web_enabled, push_enabled FROM db_notification_prefs WHERE user_id = $1",
    )
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or((true, true))
}

/// Request body for the manual compose endpoint (single-tenant: always targets
/// the authenticated admin).
#[derive(Debug, Deserialize)]
pub struct ComposeRequest {
    pub title: String,
    #[serde(default)]
    pub body: Option<String>,
    #[serde(default)]
    pub level: Option<String>,
    #[serde(default)]
    pub action_url: Option<String>,
    /// Which channels to push to in addition to the inbox: `["web","push"]`.
    #[serde(default)]
    pub channels: Option<Vec<String>>,
}

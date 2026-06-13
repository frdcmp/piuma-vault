/// Notification Worker — materializes recurring alert windows and dispatches due
/// notifications. Polls `db_scheduled_notifications` with `FOR UPDATE SKIP
/// LOCKED` (same pattern as the embedding worker), sends Web Push + Expo push to
/// the owning user's registered targets, honoring per-user channel preferences.
use std::time::Duration;
use tokio::time::sleep;

use backend::apps::notifications::models::ScheduledNotification;
use backend::apps::notifications::schedule::reschedule_source;
use backend::apps::notifications::{expo, webpush};
use backend::db;
use serde_json::json;

#[tokio::main]
async fn main() {
    env_logger::init();
    log::info!("🔔 Notification Worker starting...");

    let pool = match db::db::create_pool().await {
        Ok(p) => {
            log::info!("✅ Database connection pool established");
            p
        }
        Err(e) => {
            log::error!("❌ Failed to connect to database: {e}");
            std::process::exit(1);
        }
    };

    let poll_interval = Duration::from_secs(30);
    let max_attempts: i32 = 5;

    loop {
        // 1) Rolling refill: keep recurring sources' alert windows topped up.
        refill_recurring(&pool).await;

        // 2) Claim due rows.
        let due: Vec<ScheduledNotification> = match sqlx::query_as(
            r#"
            UPDATE db_scheduled_notifications SET attempts = attempts + 1
            WHERE id IN (
                SELECT id FROM db_scheduled_notifications
                WHERE sent_at IS NULL AND fire_at <= NOW() AND attempts < $1
                ORDER BY fire_at
                LIMIT 50
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, user_id, title, body, channels, source_type, source_id, occurrence_date
            "#,
        )
        .bind(max_attempts)
        .fetch_all(&pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                log::error!("Failed to claim due notifications: {e}");
                sleep(poll_interval).await;
                continue;
            }
        };

        if due.is_empty() {
            sleep(poll_interval).await;
            continue;
        }

        log::info!("Dispatching {} due notification(s)", due.len());

        for n in due {
            dispatch(&pool, &n).await;
            // Mark as fired regardless of per-target outcome (dead targets are
            // pruned inside the dispatchers; attempts<5 guards transient retries).
            let _ = sqlx::query("UPDATE db_scheduled_notifications SET sent_at = NOW() WHERE id = $1")
                .bind(n.id)
                .execute(&pool)
                .await;
        }
    }
}

// Re-materialize the alert window for every active recurring template and
// recurring calendar event. Idempotent (ON CONFLICT DO NOTHING in schedule.rs).
async fn refill_recurring(pool: &db::db::DbPool) {
    let recurring_ids: Vec<uuid::Uuid> =
        sqlx::query_scalar("SELECT id FROM db_recurring_tasks WHERE active = TRUE")
            .fetch_all(pool)
            .await
            .unwrap_or_default();
    for id in recurring_ids {
        if let Err(e) = reschedule_source(pool, "recurring", id).await {
            log::error!("refill recurring {id} failed: {e}");
        }
    }

    let event_ids: Vec<uuid::Uuid> = sqlx::query_scalar(
        "SELECT id FROM db_calendar_events WHERE rrule IS NOT NULL AND rrule <> ''",
    )
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    for id in event_ids {
        if let Err(e) = reschedule_source(pool, "event", id).await {
            log::error!("refill event {id} failed: {e}");
        }
    }
}

async fn dispatch(pool: &db::db::DbPool, n: &ScheduledNotification) {
    // Per-user channel preferences (default both enabled).
    let (web_enabled, push_enabled): (bool, bool) = sqlx::query_as(
        "SELECT web_enabled, push_enabled FROM db_notification_prefs WHERE user_id = $1",
    )
    .bind(&n.user_id)
    .fetch_optional(pool)
    .await
    .ok()
    .flatten()
    .unwrap_or((true, true));

    let wants_web = n.channels.iter().any(|c| c == "web") && web_enabled;
    let wants_push = n.channels.iter().any(|c| c == "push") && push_enabled;

    let url = match n.source_type.as_str() {
        "event" => "/admin/calendar",
        _ => "/admin/tasks",
    };
    let body = n.body.clone().unwrap_or_default();
    let tag = format!("{}:{}", n.source_type, n.source_id);

    if wants_web {
        let payload = json!({
            "title": n.title,
            "body": body,
            "url": url,
            "tag": tag,
        })
        .to_string();
        let sent = webpush::dispatch_web(pool, &n.user_id, &payload).await;
        log::info!("web push: {sent} delivered for '{}'", n.title);
    }

    if wants_push {
        // DATA-ONLY push: the device's background task re-displays it as a rich
        // Notifee alarm with Complete/Snooze/Dismiss buttons (handled on-device).
        // Carries the source so "Complete" can mark the right task/occurrence.
        let data = json!({
            "type": "alarm",
            "url": url,
            "tag": tag,
            "title": n.title,
            "body": body,
            "source_type": n.source_type,
            "source_id": n.source_id,
            "occurrence_date": n.occurrence_date,
        });
        let sent = expo::dispatch_expo_data(pool, &n.user_id, &data).await;
        log::info!("expo data push: {sent} delivered for '{}'", n.title);
    }
}

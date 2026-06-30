use actix_web::{web, HttpResponse, Responder};
use serde_json::json;

use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::events::NotificationsEventBus;
use super::models::{
    ExpoTokenDeleteRequest, ExpoTokenRequest, InboxQuery, NotificationPrefs, NotificationRow,
    NotificationsApiError, UpcomingNotification, UpcomingQuery, UpdatePrefsRequest,
    VapidKeyResponse, WebPushSubscribeRequest, WebPushUnsubscribeRequest,
};
use super::notify::{notify, Channels, ComposeRequest, NewNotification};
use super::{expo, webpush};

fn err(msg: impl Into<String>) -> NotificationsApiError {
    NotificationsApiError { error: msg.into() }
}

// ── Web Push subscriptions ──────────────────────────────────────────────────

pub async fn vapid_public_key() -> impl Responder {
    match webpush::public_key() {
        Some(key) => HttpResponse::Ok().json(VapidKeyResponse { key }),
        None => HttpResponse::ServiceUnavailable().json(err("Web Push not configured on the server")),
    }
}

pub async fn subscribe_web_push(
    user: AuthenticatedUser,
    body: web::Json<WebPushSubscribeRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let res = sqlx::query(
        "INSERT INTO db_push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) \
         VALUES ($1, $2, $3, $4, $5) \
         ON CONFLICT (endpoint) DO UPDATE SET \
            user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, \
            auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent",
    )
    .bind(&user.user_id)
    .bind(&body.endpoint)
    .bind(&body.keys.p256dh)
    .bind(&body.keys.auth)
    .bind(&body.user_agent)
    .execute(pool.get_ref())
    .await;

    match res {
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("web push subscribe failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to save subscription"))
        }
    }
}

pub async fn unsubscribe_web_push(
    user: AuthenticatedUser,
    body: web::Json<WebPushUnsubscribeRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    match sqlx::query("DELETE FROM db_push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(&body.endpoint)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("web push unsubscribe failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to remove subscription"))
        }
    }
}

// ── Expo device tokens ──────────────────────────────────────────────────────

pub async fn register_expo_token(
    user: AuthenticatedUser,
    body: web::Json<ExpoTokenRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let res = sqlx::query(
        "INSERT INTO db_expo_push_tokens (user_id, token, platform) VALUES ($1, $2, $3) \
         ON CONFLICT (token) DO UPDATE SET user_id = EXCLUDED.user_id, platform = EXCLUDED.platform",
    )
    .bind(&user.user_id)
    .bind(&body.token)
    .bind(&body.platform)
    .execute(pool.get_ref())
    .await;

    match res {
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("expo token register failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to register device"))
        }
    }
}

pub async fn delete_expo_token(
    user: AuthenticatedUser,
    body: web::Json<ExpoTokenDeleteRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    match sqlx::query("DELETE FROM db_expo_push_tokens WHERE token = $1 AND user_id = $2")
        .bind(&body.token)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("expo token delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to remove device"))
        }
    }
}

// ── Preferences ─────────────────────────────────────────────────────────────

pub async fn get_preferences(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let row: Option<NotificationPrefs> = sqlx::query_as(
        "SELECT web_enabled, push_enabled FROM db_notification_prefs WHERE user_id = $1",
    )
    .bind(&user.user_id)
    .fetch_optional(pool.get_ref())
    .await
    .unwrap_or(None);

    // Default = both channels enabled.
    let prefs = row.unwrap_or(NotificationPrefs {
        web_enabled: true,
        push_enabled: true,
    });
    HttpResponse::Ok().json(prefs)
}

pub async fn update_preferences(
    user: AuthenticatedUser,
    body: web::Json<UpdatePrefsRequest>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    // Upsert; COALESCE keeps the existing value for omitted fields.
    let res = sqlx::query_as::<_, NotificationPrefs>(
        "INSERT INTO db_notification_prefs (user_id, web_enabled, push_enabled, updated_at) \
         VALUES ($1, COALESCE($2, TRUE), COALESCE($3, TRUE), NOW()) \
         ON CONFLICT (user_id) DO UPDATE SET \
            web_enabled = COALESCE($2, db_notification_prefs.web_enabled), \
            push_enabled = COALESCE($3, db_notification_prefs.push_enabled), \
            updated_at = NOW() \
         RETURNING web_enabled, push_enabled",
    )
    .bind(&user.user_id)
    .bind(body.web)
    .bind(body.push)
    .fetch_one(pool.get_ref())
    .await;

    match res {
        Ok(prefs) => HttpResponse::Ok().json(prefs),
        Err(e) => {
            log::error!("update prefs failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to update preferences"))
        }
    }
}

// ── Test ─────────────────────────────────────────────────────────────────────

pub async fn test_notification(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let title = "Piuma Vault";
    let body = "🔔 Test notification — alerts are working.";
    let data = json!({ "url": "/admin/calendar", "tag": "test" });
    let payload = json!({ "title": title, "body": body, "url": "/admin/calendar", "tag": "test" })
        .to_string();

    let web_sent = webpush::dispatch_web(pool.get_ref(), &user.user_id, &payload).await;
    let push_sent = expo::dispatch_expo(pool.get_ref(), &user.user_id, title, body, &data).await;

    HttpResponse::Ok().json(json!({ "web_sent": web_sent, "push_sent": push_sent }))
}

// ── Upcoming alarms ───────────────────────────────────────────────────────────

// Returns the materialized scheduled-notification rows whose `fire_at` falls in
// the near window [now − 2 min, now + within_minutes], so an open client can
// ring an in-app alarm at the precise instant. The 2-minute grace lets a client
// that opened right after a fire still catch it. Independent of `sent_at` (which
// only tracks push dispatch), since the alarm is a separate in-app channel.
pub async fn get_upcoming(
    user: AuthenticatedUser,
    query: web::Query<UpcomingQuery>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let within = query.within_minutes.unwrap_or(180).clamp(1, 1440);

    let rows: Vec<UpcomingNotification> = sqlx::query_as(
        "SELECT id, source_type, source_id, occurrence_date, fire_at, offset_minutes, title, body \
         FROM db_scheduled_notifications \
         WHERE user_id = $1 \
           AND fire_at >= NOW() - INTERVAL '2 minutes' \
           AND fire_at <= NOW() + make_interval(mins => $2) \
         ORDER BY fire_at \
         LIMIT 200",
    )
    .bind(&user.user_id)
    .bind(within)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();

    HttpResponse::Ok().json(rows)
}

// ── In-app notification center (inbox) ────────────────────────────────────────

// Paginated inbox list (newest first). `unread_only` filters to unread; cursor
// pagination via `before` (the created_at of the last item seen). Archived rows
// are always excluded.
pub async fn list_inbox(
    user: AuthenticatedUser,
    query: web::Query<InboxQuery>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let limit = query.limit.unwrap_or(20).clamp(1, 100);
    let unread_only = query.unread_only.unwrap_or(false);

    let rows: Vec<NotificationRow> = sqlx::query_as(
        "SELECT id, category, level, title, body, action_url, metadata, count, read_at, created_at \
         FROM db_notifications \
         WHERE user_id = $1 \
           AND archived_at IS NULL \
           AND ($2 = FALSE OR read_at IS NULL) \
           AND ($3::timestamptz IS NULL OR created_at < $3) \
         ORDER BY created_at DESC \
         LIMIT $4",
    )
    .bind(&user.user_id)
    .bind(unread_only)
    .bind(query.before)
    .bind(limit)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();

    HttpResponse::Ok().json(rows)
}

// Unread count — drives the bell badge. Fast (partial index).
pub async fn unread_count(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_notifications \
         WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL",
    )
    .bind(&user.user_id)
    .fetch_one(pool.get_ref())
    .await
    .unwrap_or(0);

    HttpResponse::Ok().json(json!({ "count": count }))
}

// Mark one notification read (idempotent — only sets read_at when still null).
pub async fn mark_read(
    user: AuthenticatedUser,
    path: web::Path<uuid::Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    match sqlx::query(
        "UPDATE db_notifications SET read_at = NOW() \
         WHERE id = $1 AND user_id = $2 AND read_at IS NULL",
    )
    .bind(path.into_inner())
    .bind(&user.user_id)
    .execute(pool.get_ref())
    .await
    {
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("mark_read failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to mark read"))
        }
    }
}

// Mark all unread notifications read — fired when the bell popover opens
// ("open = seen"). Returns how many were affected.
pub async fn mark_all_read(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    match sqlx::query(
        "UPDATE db_notifications SET read_at = NOW() \
         WHERE user_id = $1 AND read_at IS NULL AND archived_at IS NULL",
    )
    .bind(&user.user_id)
    .execute(pool.get_ref())
    .await
    {
        Ok(r) => HttpResponse::Ok().json(json!({ "updated": r.rows_affected() })),
        Err(e) => {
            log::error!("mark_all_read failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to mark all read"))
        }
    }
}

// Dismiss (soft-archive) a notification so it leaves the inbox.
pub async fn dismiss_notification(
    user: AuthenticatedUser,
    path: web::Path<uuid::Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    match sqlx::query(
        "UPDATE db_notifications SET archived_at = NOW() \
         WHERE id = $1 AND user_id = $2 AND archived_at IS NULL",
    )
    .bind(path.into_inner())
    .bind(&user.user_id)
    .execute(pool.get_ref())
    .await
    {
        Ok(_) => HttpResponse::NoContent().finish(),
        Err(e) => {
            log::error!("dismiss_notification failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to dismiss"))
        }
    }
}

// Manual compose — send a notification to yourself (single-tenant). Goes to the
// inbox always, plus any push channels in `channels` (["web","push"]).
pub async fn compose_notification(
    user: AuthenticatedUser,
    body: web::Json<ComposeRequest>,
    bus: web::Data<NotificationsEventBus>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    let req = body.into_inner();
    let ch = match &req.channels {
        Some(list) => Channels::from_list(list),
        None => Channels::inbox_only(),
    };

    let mut n = NewNotification::new(&user.user_id, "manual", req.title)
        .level(req.level.unwrap_or_else(|| "info".to_string()));
    if let Some(b) = req.body {
        n = n.body(b);
    }
    if let Some(u) = req.action_url {
        n = n.action_url(u);
    }

    match notify(pool.get_ref(), Some(bus.get_ref()), n, ch).await {
        Some(r) => HttpResponse::Created().json(json!({ "id": r.id })),
        None => HttpResponse::InternalServerError().json(err("Failed to create notification")),
    }
}

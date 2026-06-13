//! CRUD + control endpoints for scheduled agent jobs (admin only). The
//! cron-worker is what actually executes them; these manage definitions and
//! expose run history. `next_run_at` is (re)computed here on every schedule
//! change so the worker can simply poll it.

use actix_web::{web, HttpResponse, Responder};
use chrono::Utc;
use serde_json::json;
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::realtime::ResourceAction;
use crate::db::db::DbPool;

use super::events::CronEventBus;
use super::models::{compute_next_run, CreateCronReq, CronJobRow, CronRunRow, UpdateCronReq};

const REQUIRED_PERM: &str = "admin_access";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(json!({ "error": "admin access required" }))
}
fn db_err(e: sqlx::Error) -> HttpResponse {
    log::error!("cron db error: {e}");
    HttpResponse::InternalServerError().json(json!({ "error": "database error" }))
}

pub async fn list_jobs(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    match sqlx::query_as::<_, CronJobRow>(
        "SELECT * FROM db_cron_jobs WHERE user_id = $1 ORDER BY created_at DESC",
    )
    .bind(&user.user_id)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => db_err(e),
    }
}

pub async fn create_job(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    bus: web::Data<CronEventBus>,
    body: web::Json<CreateCronReq>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let b = body.into_inner();
    if b.title.trim().is_empty() || b.prompt.trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({ "error": "title and prompt are required" }));
    }
    if b.schedule_kind != "recurring" && b.schedule_kind != "once" {
        return HttpResponse::BadRequest().json(json!({ "error": "schedule_kind must be 'recurring' or 'once'" }));
    }
    if b.schedule_kind == "recurring" && b.rrule.as_deref().unwrap_or("").trim().is_empty() {
        return HttpResponse::BadRequest().json(json!({ "error": "recurring jobs need an rrule" }));
    }
    if b.schedule_kind == "once" && b.run_at.is_none() {
        return HttpResponse::BadRequest().json(json!({ "error": "one-shot jobs need run_at" }));
    }

    let next = compute_next_run(
        &b.schedule_kind,
        b.rrule.as_deref(),
        b.dtstart,
        b.run_at,
        Utc::now(),
    );
    let agent = b.agent.unwrap_or_else(|| "vault_agent".to_string());
    let timezone = b.timezone.unwrap_or_else(|| "Europe/Rome".to_string());
    let channels = b.notify_channels.unwrap_or_else(|| vec!["web".into(), "push".into()]);
    let max_runtime = b.max_runtime_secs.unwrap_or(180).clamp(15, 600);

    match sqlx::query_as::<_, CronJobRow>(
        "INSERT INTO db_cron_jobs \
           (user_id, title, prompt, agent, schedule_kind, rrule, dtstart, run_at, timezone, \
            next_run_at, notify, notify_channels, allow_destructive, max_runtime_secs) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *",
    )
    .bind(&user.user_id)
    .bind(b.title.trim())
    .bind(b.prompt.trim())
    .bind(&agent)
    .bind(&b.schedule_kind)
    .bind(&b.rrule)
    .bind(b.dtstart)
    .bind(b.run_at)
    .bind(&timezone)
    .bind(next)
    .bind(b.notify)
    .bind(&channels)
    .bind(b.allow_destructive)
    .bind(max_runtime)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(row) => {
            bus.publish(ResourceAction::Created, row.id);
            HttpResponse::Ok().json(row)
        }
        Err(e) => db_err(e),
    }
}

async fn load_owned(pool: &DbPool, id: Uuid, user_id: &str) -> Result<Option<CronJobRow>, sqlx::Error> {
    sqlx::query_as::<_, CronJobRow>("SELECT * FROM db_cron_jobs WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
}

pub async fn get_job(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let id = path.into_inner();
    let job = match load_owned(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(j)) => j,
        Ok(None) => return HttpResponse::NotFound().json(json!({ "error": "not found" })),
        Err(e) => return db_err(e),
    };
    let runs: Vec<CronRunRow> = sqlx::query_as(
        "SELECT * FROM db_cron_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 20",
    )
    .bind(id)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    HttpResponse::Ok().json(json!({ "job": job, "runs": runs }))
}

pub async fn update_job(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    bus: web::Data<CronEventBus>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateCronReq>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let id = path.into_inner();
    let b = body.into_inner();
    let cur = match load_owned(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(j)) => j,
        Ok(None) => return HttpResponse::NotFound().json(json!({ "error": "not found" })),
        Err(e) => return db_err(e),
    };

    // Merge incoming overrides onto the current row, then recompute next_run_at.
    let title = b.title.unwrap_or(cur.title);
    let prompt = b.prompt.unwrap_or(cur.prompt);
    let schedule_kind = b.schedule_kind.unwrap_or(cur.schedule_kind);
    let rrule = b.rrule.or(cur.rrule);
    let dtstart = b.dtstart.or(cur.dtstart);
    let run_at = b.run_at.or(cur.run_at);
    let timezone = b.timezone.unwrap_or(cur.timezone);
    let notify = b.notify.unwrap_or(cur.notify);
    let channels = b.notify_channels.unwrap_or(cur.notify_channels);
    let allow_destructive = b.allow_destructive.unwrap_or(cur.allow_destructive);
    let enabled = b.enabled.unwrap_or(cur.enabled);
    let max_runtime = b.max_runtime_secs.unwrap_or(cur.max_runtime_secs).clamp(15, 600);
    let next = if enabled {
        compute_next_run(&schedule_kind, rrule.as_deref(), dtstart, run_at, Utc::now())
    } else {
        None
    };

    match sqlx::query_as::<_, CronJobRow>(
        "UPDATE db_cron_jobs SET \
            title=$2, prompt=$3, schedule_kind=$4, rrule=$5, dtstart=$6, run_at=$7, timezone=$8, \
            next_run_at=$9, notify=$10, notify_channels=$11, allow_destructive=$12, enabled=$13, \
            max_runtime_secs=$14, updated_at=NOW() \
         WHERE id=$1 RETURNING *",
    )
    .bind(id)
    .bind(&title)
    .bind(&prompt)
    .bind(&schedule_kind)
    .bind(&rrule)
    .bind(dtstart)
    .bind(run_at)
    .bind(&timezone)
    .bind(next)
    .bind(notify)
    .bind(&channels)
    .bind(allow_destructive)
    .bind(enabled)
    .bind(max_runtime)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(row) => {
            bus.publish(ResourceAction::Updated, row.id);
            HttpResponse::Ok().json(row)
        }
        Err(e) => db_err(e),
    }
}

pub async fn delete_job(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    bus: web::Data<CronEventBus>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let id = path.into_inner();
    match sqlx::query("DELETE FROM db_cron_jobs WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            bus.publish(ResourceAction::Deleted, id);
            HttpResponse::Ok().json(json!({ "deleted": true }))
        }
        Ok(_) => HttpResponse::NotFound().json(json!({ "error": "not found" })),
        Err(e) => db_err(e),
    }
}

/// Enqueue an immediate run: set `next_run_at = NOW()` (+ enable) so the worker
/// picks it up on its next tick. Manual test / "run now" button.
pub async fn run_now(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    bus: web::Data<CronEventBus>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let id = path.into_inner();
    match sqlx::query(
        "UPDATE db_cron_jobs SET next_run_at = NOW(), enabled = TRUE WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(&user.user_id)
    .execute(pool.get_ref())
    .await
    {
        Ok(r) if r.rows_affected() > 0 => {
            bus.publish(ResourceAction::Updated, id);
            HttpResponse::Accepted().json(json!({ "queued": true }))
        }
        Ok(_) => HttpResponse::NotFound().json(json!({ "error": "not found" })),
        Err(e) => db_err(e),
    }
}

pub async fn toggle_job(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    bus: web::Data<CronEventBus>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let id = path.into_inner();
    // Flip enabled; when re-enabling, recompute next_run_at from the schedule.
    match sqlx::query_as::<_, CronJobRow>(
        "UPDATE db_cron_jobs SET enabled = NOT enabled, \
            next_run_at = CASE WHEN NOT enabled THEN next_run_at ELSE NULL END, \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING *",
    )
    .bind(id)
    .bind(&user.user_id)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(mut row)) => {
            // If we just enabled it, fill in the next fire time.
            if row.enabled {
                let next = compute_next_run(
                    &row.schedule_kind,
                    row.rrule.as_deref(),
                    row.dtstart,
                    row.run_at,
                    Utc::now(),
                );
                let _ = sqlx::query("UPDATE db_cron_jobs SET next_run_at = $2 WHERE id = $1")
                    .bind(id)
                    .bind(next)
                    .execute(pool.get_ref())
                    .await;
                row.next_run_at = next;
            }
            bus.publish(ResourceAction::Updated, id);
            HttpResponse::Ok().json(row)
        }
        Ok(None) => HttpResponse::NotFound().json(json!({ "error": "not found" })),
        Err(e) => db_err(e),
    }
}

pub async fn list_runs(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let id = path.into_inner();
    // Verify ownership before exposing runs.
    match load_owned(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(_)) => {}
        Ok(None) => return HttpResponse::NotFound().json(json!({ "error": "not found" })),
        Err(e) => return db_err(e),
    }
    let runs: Vec<CronRunRow> = sqlx::query_as(
        "SELECT * FROM db_cron_runs WHERE job_id = $1 ORDER BY started_at DESC LIMIT 50",
    )
    .bind(id)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    HttpResponse::Ok().json(runs)
}

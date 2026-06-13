use actix_web::{web, HttpResponse, Responder};
use chrono::{DateTime, NaiveDate, Utc};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::buckets::sync_tags;
use crate::apps::realtime::ResourceAction;
use crate::db::db::DbPool;

use super::events::TasksEventBus;
use super::models::{
    CompleteOccurrenceRequest, CreateRecurringTaskRequest, CreateTaskRequest, ListTasksQuery,
    RecurringTask, Task, TasksApiError, UpdateRecurringTaskRequest, UpdateTaskRequest,
};

// `tags` is assembled from the join table (db_task_tags → db_tags) as a name
// array, so the API shape (Task.tags: Vec<String>) is unchanged. FromRow maps by
// column name, so the aliased subquery slots in regardless of position.
const TASK_FIELDS: &str = "id, user_id, title, notes, done, completed_at, due_at, priority, \
     bucket_id, \
     (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_task_tags tt \
      JOIN db_tags tg ON tg.id = tt.tag_id WHERE tt.task_id = db_tasks.id) AS tags, \
     rank, recurrence_id, occurrence_date, alerts, created_at, updated_at";

const RECURRING_FIELDS: &str = "id, user_id, title, notes, priority, bucket_id, \
     (SELECT COALESCE(array_agg(tg.name ORDER BY tg.name), '{}') FROM db_recurring_task_tags rtt \
      JOIN db_tags tg ON tg.id = rtt.tag_id WHERE rtt.recurring_id = db_recurring_tasks.id) AS tags, \
     rrule, dtstart, until, active, alerts, created_at, updated_at";

fn err(msg: impl Into<String>) -> TasksApiError {
    TasksApiError { error: msg.into() }
}

// Best-effort (re)materialization of a source's alert schedule.
async fn reschedule(pool: &DbPool, source_type: &str, source_id: Uuid) {
    if let Err(e) =
        crate::apps::notifications::schedule::reschedule_source(pool, source_type, source_id).await
    {
        log::error!("tasks reschedule failed for {source_type} {source_id}: {e}");
    }
}

async fn fetch_task(pool: &DbPool, id: Uuid, user_id: &str) -> Result<Option<Task>, sqlx::Error> {
    sqlx::query_as::<_, Task>(&format!(
        "SELECT {TASK_FIELDS} FROM db_tasks WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

async fn fetch_recurring(
    pool: &DbPool,
    id: Uuid,
    user_id: &str,
) -> Result<Option<RecurringTask>, sqlx::Error> {
    sqlx::query_as::<_, RecurringTask>(&format!(
        "SELECT {RECURRING_FIELDS} FROM db_recurring_tasks WHERE id = $1 AND user_id = $2"
    ))
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
}

fn require_read(user: &AuthenticatedUser) -> Option<HttpResponse> {
    // `tasks.manage` is the full-control scope for third-party task managers; it
    // satisfies both read and write. `admin_access` is handled by check_permission.
    if check_permission(user, "tasks.read") || check_permission(user, "tasks.manage") {
        None
    } else {
        Some(HttpResponse::Forbidden().json(err(
            "Access denied: tasks.read or tasks.manage permission required",
        )))
    }
}

fn require_write(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if check_permission(user, "tasks.write") || check_permission(user, "tasks.manage") {
        None
    } else {
        Some(HttpResponse::Forbidden().json(err(
            "Access denied: tasks.write or tasks.manage permission required",
        )))
    }
}

fn validate_task(title: &str, tags: &[String]) -> Option<HttpResponse> {
    if title.trim().is_empty() {
        return Some(HttpResponse::BadRequest().json(err("Title is required")));
    }
    if title.len() > 500 {
        return Some(HttpResponse::BadRequest().json(err("Title must be 500 chars or fewer")));
    }
    if tags.len() > 20 {
        return Some(HttpResponse::BadRequest().json(err("Maximum 20 tags per task")));
    }
    None
}

// A task alert is an offset *before* due_at, so without a due date there is no
// anchor to schedule against — the alert would be stored but never fire. Reject
// that combination up front instead of silently dropping it.
fn alerts_present(alerts: &serde_json::Value) -> bool {
    alerts.as_array().map(|a| !a.is_empty()).unwrap_or(false)
}

// ── TASKS: LIST ──────────────────────────────────────────────────────────────

pub async fn list_tasks(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<ListTasksQuery>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }

    let mut clauses = vec!["user_id = $1".to_string()];
    let mut idx = 2u32;
    if query.done.is_some() {
        clauses.push(format!("done = ${idx}"));
        idx += 1;
    }
    if query.due_before.is_some() {
        clauses.push(format!("due_at < ${idx}"));
        idx += 1;
    }
    if query.due_after.is_some() {
        clauses.push(format!("due_at >= ${idx}"));
        idx += 1;
    }
    if query.tag.is_some() {
        clauses.push(format!(
            "EXISTS (SELECT 1 FROM db_task_tags tt JOIN db_tags tg ON tg.id = tt.tag_id \
             WHERE tt.task_id = db_tasks.id AND tg.name = ${idx})"
        ));
        idx += 1;
    }
    if query.bucket.is_some() {
        clauses.push(format!("bucket_id = ${idx}"));
        idx += 1;
    }
    // The "no bucket" view (no placeholder needed).
    if query.no_bucket == Some(true) {
        clauses.push("bucket_id IS NULL".to_string());
    }
    // Restrict to one-off (recurring=false) or materialized recurring-occurrence
    // (recurring=true) rows. Absent => both.
    match query.recurring {
        Some(true) => clauses.push("recurrence_id IS NOT NULL".to_string()),
        Some(false) => clauses.push("recurrence_id IS NULL".to_string()),
        None => {}
    }

    // A done-only listing is a completion *history*: most-recently-finished
    // first. Any other listing keeps the manual order (pending before done, then
    // by the fractional-index `rank`, NULLS LAST so unranked rows trail, with
    // created_at as a stable final tiebreaker).
    let order_by = if query.done == Some(true) {
        "completed_at DESC NULLS LAST, created_at DESC"
    } else {
        "done ASC, rank ASC NULLS LAST, created_at ASC"
    };

    // Optional pagination (`limit`/`offset`) — used by the mobile completed-task
    // history, which pages instead of loading every done task at once. Absent =>
    // return the full set (the default for the web client). LIMIT is clamped so a
    // bad client can't request an unbounded page.
    let mut tail = String::new();
    if query.limit.is_some() {
        tail.push_str(&format!(" LIMIT ${idx}"));
        idx += 1;
        tail.push_str(&format!(" OFFSET ${idx}"));
    }
    let _ = idx; // last placeholder index consumed; keeps the bucket bump honest

    let sql = format!(
        "SELECT {TASK_FIELDS} FROM db_tasks WHERE {} ORDER BY {order_by}{tail}",
        clauses.join(" AND ")
    );

    let mut q = sqlx::query_as::<_, Task>(&sql).bind(&user.user_id);
    if let Some(done) = query.done {
        q = q.bind(done);
    }
    if let Some(before) = query.due_before {
        q = q.bind(before);
    }
    if let Some(after) = query.due_after {
        q = q.bind(after);
    }
    if let Some(ref tag) = query.tag {
        q = q.bind(tag);
    }
    if let Some(bucket) = query.bucket {
        q = q.bind(bucket);
    }
    if let Some(limit) = query.limit {
        q = q.bind(limit.clamp(1, 200));
        q = q.bind(query.offset.unwrap_or(0).max(0));
    }

    match q.fetch_all(pool.get_ref()).await {
        Ok(data) => HttpResponse::Ok().json(data),
        Err(e) => {
            log::error!("tasks list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch tasks"))
        }
    }
}

// ── TASKS: CREATE ────────────────────────────────────────────────────────────

pub async fn create_task(
    user: AuthenticatedUser,
    body: web::Json<CreateTaskRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    if let Some(r) = validate_task(&body.title, &body.tags) {
        return r;
    }
    if alerts_present(&body.alerts) && body.due_at.is_none() {
        return HttpResponse::BadRequest().json(err("A due date is required to set alerts"));
    }

    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO db_tasks (user_id, title, notes, due_at, priority, bucket_id, alerts, rank) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(&user.user_id)
    .bind(&body.title)
    .bind(&body.notes)
    .bind(body.due_at)
    .bind(body.priority)
    .bind(body.bucket_id)
    .bind(&body.alerts)
    .bind(&body.rank)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::error!("tasks create failed: {e}");
            return HttpResponse::BadRequest().json(err("Failed to create task"));
        }
    };

    if let Err(e) = sync_tags(pool.get_ref(), &user.user_id, "db_task_tags", "task_id", id, &body.tags).await {
        log::error!("task tag sync failed: {e}");
    }
    reschedule(pool.get_ref(), "task", id).await;
    bus.publish(ResourceAction::Created, id);

    match fetch_task(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(task)) => HttpResponse::Created().json(task),
        _ => HttpResponse::InternalServerError().json(err("Created but failed to load task")),
    }
}

// ── TASKS: GET ───────────────────────────────────────────────────────────────

pub async fn get_task(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    match fetch_task(pool.get_ref(), path.into_inner(), &user.user_id).await {
        Ok(Some(task)) => HttpResponse::Ok().json(task),
        Ok(None) => HttpResponse::NotFound().json(err("Task not found")),
        Err(e) => {
            log::error!("tasks get failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch task"))
        }
    }
}

// ── TASKS: UPDATE (partial) ───────────────────────────────────────────────────

pub async fn update_task(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateTaskRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    if let Some(ref title) = body.title {
        if let Some(r) = validate_task(title, body.tags.as_deref().unwrap_or(&[])) {
            return r;
        }
    }

    // Alerts need a due_at anchor. Compute the effective state after this patch
    // and reject "alerts without a due date".
    let touches_alerts = body.alerts.is_some();
    let clears_due = matches!(body.due_at, Some(None));
    if touches_alerts || clears_due {
        let current: Option<(Option<DateTime<Utc>>, serde_json::Value)> = match sqlx::query_as(
            "SELECT due_at, alerts FROM db_tasks WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
        {
            Ok(row) => row,
            Err(e) => {
                log::error!("tasks update precheck failed: {e}");
                return HttpResponse::InternalServerError().json(err("Failed to update task"));
            }
        };
        if let Some((cur_due, cur_alerts)) = current {
            let effective_due = match body.due_at {
                Some(v) => v,
                None => cur_due,
            };
            let effective_alerts = body.alerts.as_ref().unwrap_or(&cur_alerts);
            if alerts_present(effective_alerts) && effective_due.is_none() {
                return HttpResponse::BadRequest()
                    .json(err("A due date is required to set alerts"));
            }
        }
    }

    // `done` toggling also stamps/clears completed_at in the same statement.
    let sql = "UPDATE db_tasks SET \
            title = COALESCE($3, title), \
            notes = CASE WHEN $4 THEN $5 ELSE notes END, \
            due_at = CASE WHEN $6 THEN $7 ELSE due_at END, \
            priority = COALESCE($8, priority), \
            rank = COALESCE($9, rank), \
            done = COALESCE($10, done), \
            completed_at = CASE WHEN $10 IS NULL THEN completed_at \
                                WHEN $10 THEN NOW() ELSE NULL END, \
            alerts = COALESCE($11, alerts), \
            bucket_id = CASE WHEN $12 THEN $13 ELSE bucket_id END, \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING id";

    let (set_notes, notes) = match &body.notes {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };
    let (set_due, due) = match &body.due_at {
        Some(v) => (true, *v),
        None => (false, None),
    };
    let (set_bucket, bucket) = match &body.bucket_id {
        Some(v) => (true, *v),
        None => (false, None),
    };

    let found: Option<Uuid> = match sqlx::query_scalar(sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(set_notes)
        .bind(notes)
        .bind(set_due)
        .bind(due)
        .bind(body.priority)
        .bind(&body.rank)
        .bind(body.done)
        .bind(&body.alerts)
        .bind(set_bucket)
        .bind(bucket)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("tasks update failed: {e}");
            return HttpResponse::BadRequest().json(err("Failed to update task"));
        }
    };
    if found.is_none() {
        return HttpResponse::NotFound().json(err("Task not found"));
    }

    if let Some(ref tags) = body.tags {
        if let Err(e) = sync_tags(pool.get_ref(), &user.user_id, "db_task_tags", "task_id", id, tags).await {
            log::error!("task tag sync failed: {e}");
        }
    }
    reschedule(pool.get_ref(), "task", id).await;
    bus.publish(ResourceAction::Updated, id);

    match fetch_task(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(task)) => HttpResponse::Ok().json(task),
        _ => HttpResponse::InternalServerError().json(err("Updated but failed to load task")),
    }
}

// ── TASKS: TOGGLE done ─────────────────────────────────────────────────────────

pub async fn toggle_task(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    // Flip `done` and stamp/clear completed_at accordingly, atomically. Tag links
    // are unchanged, so the RETURNING subquery reflects current tags.
    let sql = format!(
        "UPDATE db_tasks SET \
            done = NOT done, \
            completed_at = CASE WHEN NOT done THEN NOW() ELSE NULL END, \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {TASK_FIELDS}"
    );
    match sqlx::query_as::<_, Task>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(task)) => {
            // Completed tasks suppress pending alerts; un-completing restores them.
            if task.done {
                let _ = crate::apps::notifications::schedule::purge_source(
                    pool.get_ref(),
                    "task",
                    task.id,
                )
                .await;
            } else {
                reschedule(pool.get_ref(), "task", task.id).await;
            }
            bus.publish(ResourceAction::Updated, task.id);
            HttpResponse::Ok().json(task)
        }
        Ok(None) => HttpResponse::NotFound().json(err("Task not found")),
        Err(e) => {
            log::error!("tasks toggle failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to toggle task"))
        }
    }
}

// ── TASKS: DELETE ───────────────────────────────────────────────────────────

pub async fn delete_task(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    // db_task_tags rows cascade on delete.
    match sqlx::query("DELETE FROM db_tasks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() == 0 => HttpResponse::NotFound().json(err("Task not found")),
        Ok(_) => {
            let _ =
                crate::apps::notifications::schedule::purge_source(pool.get_ref(), "task", id).await;
            bus.publish(ResourceAction::Deleted, id);
            HttpResponse::NoContent().finish()
        }
        Err(e) => {
            log::error!("tasks delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete task"))
        }
    }
}

// ── RECURRING TASKS: LIST ──────────────────────────────────────────────────────

pub async fn list_recurring(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    let sql = format!(
        "SELECT {RECURRING_FIELDS} FROM db_recurring_tasks WHERE user_id = $1 ORDER BY created_at ASC"
    );
    match sqlx::query_as::<_, RecurringTask>(&sql)
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(data) => HttpResponse::Ok().json(data),
        Err(e) => {
            log::error!("recurring list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch recurring tasks"))
        }
    }
}

// ── RECURRING TASKS: CREATE ─────────────────────────────────────────────────────

pub async fn create_recurring(
    user: AuthenticatedUser,
    body: web::Json<CreateRecurringTaskRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    if let Some(r) = validate_task(&body.title, &body.tags) {
        return r;
    }
    if body.rrule.trim().is_empty() {
        return HttpResponse::BadRequest().json(err("rrule is required"));
    }

    let id: Uuid = match sqlx::query_scalar(
        "INSERT INTO db_recurring_tasks (user_id, title, notes, priority, bucket_id, rrule, dtstart, until, alerts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id",
    )
    .bind(&user.user_id)
    .bind(&body.title)
    .bind(&body.notes)
    .bind(body.priority)
    .bind(body.bucket_id)
    .bind(&body.rrule)
    .bind(body.dtstart)
    .bind(body.until)
    .bind(&body.alerts)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::error!("recurring create failed: {e}");
            return HttpResponse::BadRequest().json(err("Failed to create recurring task"));
        }
    };

    if let Err(e) = sync_tags(pool.get_ref(), &user.user_id, "db_recurring_task_tags", "recurring_id", id, &body.tags).await {
        log::error!("recurring tag sync failed: {e}");
    }
    reschedule(pool.get_ref(), "recurring", id).await;
    bus.publish(ResourceAction::Created, id);

    match fetch_recurring(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(rt)) => HttpResponse::Created().json(rt),
        _ => HttpResponse::InternalServerError().json(err("Created but failed to load recurring task")),
    }
}

// ── RECURRING TASKS: GET ─────────────────────────────────────────────────────────

pub async fn get_recurring(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    match fetch_recurring(pool.get_ref(), path.into_inner(), &user.user_id).await {
        Ok(Some(rt)) => HttpResponse::Ok().json(rt),
        Ok(None) => HttpResponse::NotFound().json(err("Recurring task not found")),
        Err(e) => {
            log::error!("recurring get failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch recurring task"))
        }
    }
}

// ── RECURRING TASKS: UPDATE (partial) ───────────────────────────────────────────

pub async fn update_recurring(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateRecurringTaskRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    if let Some(ref title) = body.title {
        if let Some(r) = validate_task(title, body.tags.as_deref().unwrap_or(&[])) {
            return r;
        }
    }

    let sql = "UPDATE db_recurring_tasks SET \
            title = COALESCE($3, title), \
            notes = CASE WHEN $4 THEN $5 ELSE notes END, \
            priority = COALESCE($6, priority), \
            rrule = COALESCE($7, rrule), \
            dtstart = COALESCE($8, dtstart), \
            until = CASE WHEN $9 THEN $10 ELSE until END, \
            active = COALESCE($11, active), \
            alerts = COALESCE($12, alerts), \
            bucket_id = CASE WHEN $13 THEN $14 ELSE bucket_id END, \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING id";

    let (set_notes, notes) = match &body.notes {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };
    let (set_until, until) = match &body.until {
        Some(v) => (true, *v),
        None => (false, None),
    };
    let (set_bucket, bucket) = match &body.bucket_id {
        Some(v) => (true, *v),
        None => (false, None),
    };

    let found: Option<Uuid> = match sqlx::query_scalar(sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(set_notes)
        .bind(notes)
        .bind(body.priority)
        .bind(&body.rrule)
        .bind(body.dtstart)
        .bind(set_until)
        .bind(until)
        .bind(body.active)
        .bind(&body.alerts)
        .bind(set_bucket)
        .bind(bucket)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("recurring update failed: {e}");
            return HttpResponse::BadRequest().json(err("Failed to update recurring task"));
        }
    };
    if found.is_none() {
        return HttpResponse::NotFound().json(err("Recurring task not found"));
    }

    if let Some(ref tags) = body.tags {
        if let Err(e) =
            sync_tags(pool.get_ref(), &user.user_id, "db_recurring_task_tags", "recurring_id", id, tags).await
        {
            log::error!("recurring tag sync failed: {e}");
        }
    }
    // Rebuild the rolling window from scratch (rrule/dtstart/active/alerts may have changed).
    let _ = crate::apps::notifications::schedule::purge_source(pool.get_ref(), "recurring", id).await;
    reschedule(pool.get_ref(), "recurring", id).await;
    bus.publish(ResourceAction::Updated, id);

    match fetch_recurring(pool.get_ref(), id, &user.user_id).await {
        Ok(Some(rt)) => HttpResponse::Ok().json(rt),
        _ => HttpResponse::InternalServerError().json(err("Updated but failed to load recurring task")),
    }
}

// ── RECURRING TASKS: DELETE ──────────────────────────────────────────────────────

pub async fn delete_recurring(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    // ON DELETE CASCADE drops materialized occurrence rows in db_tasks (and the
    // recurring template's tag links) too.
    match sqlx::query("DELETE FROM db_recurring_tasks WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() == 0 => {
            HttpResponse::NotFound().json(err("Recurring task not found"))
        }
        Ok(_) => {
            let _ = crate::apps::notifications::schedule::purge_source(
                pool.get_ref(),
                "recurring",
                id,
            )
            .await;
            bus.publish(ResourceAction::Deleted, id);
            HttpResponse::NoContent().finish()
        }
        Err(e) => {
            log::error!("recurring delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete recurring task"))
        }
    }
}

// ── RECURRING TASKS: COMPLETE / UNCOMPLETE one occurrence ────────────────────────
//
// Materialize-on-complete: marking a virtual occurrence done writes (or upserts)
// a concrete db_tasks row carrying recurrence_id + occurrence_date, and copies
// the template's tag links onto it. Unchecking deletes that row (its links
// cascade), reverting the occurrence to a pending virtual to-do.

pub async fn complete_occurrence(
    user: AuthenticatedUser,
    path: web::Path<(Uuid, String)>,
    body: Option<web::Json<CompleteOccurrenceRequest>>,
    pool: web::Data<DbPool>,
    bus: web::Data<TasksEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let (recurrence_id, date_str) = path.into_inner();
    let occurrence_date = match NaiveDate::parse_from_str(&date_str, "%Y-%m-%d") {
        Ok(d) => d,
        Err(_) => {
            return HttpResponse::BadRequest().json(err("occurrence date must be YYYY-MM-DD"))
        }
    };
    let done = body.map(|b| b.done).unwrap_or(true);

    // Confirm the template belongs to the user before materializing (and get its tags).
    let template = match fetch_recurring(pool.get_ref(), recurrence_id, &user.user_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return HttpResponse::NotFound().json(err("Recurring task not found")),
        Err(e) => {
            log::error!("recurring lookup failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to load recurring task"));
        }
    };

    if !done {
        match sqlx::query(
            "DELETE FROM db_tasks WHERE recurrence_id = $1 AND occurrence_date = $2 AND user_id = $3",
        )
        .bind(recurrence_id)
        .bind(occurrence_date)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
        {
            Ok(_) => {
                bus.publish(ResourceAction::Updated, recurrence_id);
                return HttpResponse::NoContent().finish();
            }
            Err(e) => {
                log::error!("occurrence uncomplete failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to uncomplete occurrence"));
            }
        }
    }

    // Complete: idempotent upsert keyed by the unique (recurrence_id, occurrence_date).
    let task_id: Uuid = match sqlx::query_scalar(
        "INSERT INTO db_tasks \
            (user_id, title, notes, done, completed_at, priority, bucket_id, recurrence_id, occurrence_date) \
         VALUES ($1, $2, $3, TRUE, NOW(), $4, $5, $6, $7) \
         ON CONFLICT (recurrence_id, occurrence_date) \
         DO UPDATE SET done = TRUE, completed_at = NOW(), updated_at = NOW() \
         RETURNING id",
    )
    .bind(&user.user_id)
    .bind(&template.title)
    .bind(&template.notes)
    .bind(template.priority)
    .bind(template.bucket_id)
    .bind(recurrence_id)
    .bind(occurrence_date)
    .fetch_one(pool.get_ref())
    .await
    {
        Ok(id) => id,
        Err(e) => {
            log::error!("occurrence complete failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to complete occurrence"));
        }
    };

    // Mirror the template's tags onto the materialized occurrence.
    if let Err(e) =
        sync_tags(pool.get_ref(), &user.user_id, "db_task_tags", "task_id", task_id, &template.tags).await
    {
        log::error!("occurrence tag sync failed: {e}");
    }
    bus.publish(ResourceAction::Updated, recurrence_id);

    match fetch_task(pool.get_ref(), task_id, &user.user_id).await {
        Ok(Some(task)) => HttpResponse::Ok().json(task),
        _ => HttpResponse::InternalServerError().json(err("Completed but failed to load occurrence")),
    }
}

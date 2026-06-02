use actix_web::{web, HttpResponse, Responder};
use chrono::NaiveDate;
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::{
    CompleteOccurrenceRequest, CreateRecurringTaskRequest, CreateTaskRequest, ListTasksQuery,
    RecurringTask, Task, TasksApiError, UpdateRecurringTaskRequest, UpdateTaskRequest,
};

const TASK_FIELDS: &str = "id, user_id, title, notes, done, completed_at, due_at, priority, \
     tags, sort_order, recurrence_id, occurrence_date, alerts, created_at, updated_at";

const RECURRING_FIELDS: &str = "id, user_id, title, notes, priority, tags, rrule, dtstart, \
     until, active, alerts, created_at, updated_at";

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
        clauses.push(format!("${idx} = ANY(tags)"));
    }

    let sql = format!(
        "SELECT {TASK_FIELDS} FROM db_tasks WHERE {} \
         ORDER BY done ASC, sort_order ASC, COALESCE(due_at, 'infinity'::timestamptz) ASC, created_at ASC",
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
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    if let Some(r) = validate_task(&body.title, &body.tags) {
        return r;
    }

    let sql = format!(
        "INSERT INTO db_tasks (user_id, title, notes, due_at, priority, tags, alerts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING {TASK_FIELDS}"
    );
    match sqlx::query_as::<_, Task>(&sql)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(&body.notes)
        .bind(body.due_at)
        .bind(body.priority)
        .bind(&body.tags)
        .bind(&body.alerts)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(task) => {
            reschedule(pool.get_ref(), "task", task.id).await;
            HttpResponse::Created().json(task)
        }
        Err(e) => {
            log::error!("tasks create failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to create task"))
        }
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
    let id = path.into_inner();
    let sql = format!("SELECT {TASK_FIELDS} FROM db_tasks WHERE id = $1 AND user_id = $2");
    match sqlx::query_as::<_, Task>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
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

    // `done` toggling also stamps/clears completed_at in the same statement.
    let sql = format!(
        "UPDATE db_tasks SET \
            title = COALESCE($3, title), \
            notes = CASE WHEN $4 THEN $5 ELSE notes END, \
            due_at = CASE WHEN $6 THEN $7 ELSE due_at END, \
            priority = COALESCE($8, priority), \
            tags = COALESCE($9, tags), \
            sort_order = COALESCE($10, sort_order), \
            done = COALESCE($11, done), \
            completed_at = CASE WHEN $11 IS NULL THEN completed_at \
                                WHEN $11 THEN NOW() ELSE NULL END, \
            alerts = COALESCE($12, alerts), \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {TASK_FIELDS}"
    );

    let (set_notes, notes) = match &body.notes {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };
    let (set_due, due) = match &body.due_at {
        Some(v) => (true, *v),
        None => (false, None),
    };

    match sqlx::query_as::<_, Task>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(set_notes)
        .bind(notes)
        .bind(set_due)
        .bind(due)
        .bind(body.priority)
        .bind(&body.tags)
        .bind(body.sort_order)
        .bind(body.done)
        .bind(&body.alerts)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(task)) => {
            reschedule(pool.get_ref(), "task", task.id).await;
            HttpResponse::Ok().json(task)
        }
        Ok(None) => HttpResponse::NotFound().json(err("Task not found")),
        Err(e) => {
            log::error!("tasks update failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to update task"))
        }
    }
}

// ── TASKS: TOGGLE done ─────────────────────────────────────────────────────────

pub async fn toggle_task(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    // Flip `done` and stamp/clear completed_at accordingly, atomically.
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
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
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
            HttpResponse::NoContent().finish()
        }
        Err(e) => {
            log::error!("tasks delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete task"))
        }
    }
}

// ── RECURRING TASKS: LIST ──────────────────────────────────────────────────────

pub async fn list_recurring(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
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

    let sql = format!(
        "INSERT INTO db_recurring_tasks (user_id, title, notes, priority, tags, rrule, dtstart, until, alerts) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING {RECURRING_FIELDS}"
    );
    match sqlx::query_as::<_, RecurringTask>(&sql)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(&body.notes)
        .bind(body.priority)
        .bind(&body.tags)
        .bind(&body.rrule)
        .bind(body.dtstart)
        .bind(body.until)
        .bind(&body.alerts)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(rt) => {
            reschedule(pool.get_ref(), "recurring", rt.id).await;
            HttpResponse::Created().json(rt)
        }
        Err(e) => {
            log::error!("recurring create failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to create recurring task"))
        }
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
    let id = path.into_inner();
    let sql =
        format!("SELECT {RECURRING_FIELDS} FROM db_recurring_tasks WHERE id = $1 AND user_id = $2");
    match sqlx::query_as::<_, RecurringTask>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
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

    let sql = format!(
        "UPDATE db_recurring_tasks SET \
            title = COALESCE($3, title), \
            notes = CASE WHEN $4 THEN $5 ELSE notes END, \
            priority = COALESCE($6, priority), \
            tags = COALESCE($7, tags), \
            rrule = COALESCE($8, rrule), \
            dtstart = COALESCE($9, dtstart), \
            until = CASE WHEN $10 THEN $11 ELSE until END, \
            active = COALESCE($12, active), \
            alerts = COALESCE($13, alerts), \
            updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 RETURNING {RECURRING_FIELDS}"
    );

    let (set_notes, notes) = match &body.notes {
        Some(v) => (true, v.clone()),
        None => (false, None),
    };
    let (set_until, until) = match &body.until {
        Some(v) => (true, *v),
        None => (false, None),
    };

    match sqlx::query_as::<_, RecurringTask>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(set_notes)
        .bind(notes)
        .bind(body.priority)
        .bind(&body.tags)
        .bind(&body.rrule)
        .bind(body.dtstart)
        .bind(set_until)
        .bind(until)
        .bind(body.active)
        .bind(&body.alerts)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(rt)) => {
            // Rebuild the rolling window from scratch (rrule/dtstart/active/alerts may have changed).
            let _ = crate::apps::notifications::schedule::purge_source(
                pool.get_ref(),
                "recurring",
                rt.id,
            )
            .await;
            reschedule(pool.get_ref(), "recurring", rt.id).await;
            HttpResponse::Ok().json(rt)
        }
        Ok(None) => HttpResponse::NotFound().json(err("Recurring task not found")),
        Err(e) => {
            log::error!("recurring update failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to update recurring task"))
        }
    }
}

// ── RECURRING TASKS: DELETE ──────────────────────────────────────────────────────

pub async fn delete_recurring(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();
    // ON DELETE CASCADE drops materialized occurrence rows in db_tasks too.
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
// a concrete db_tasks row carrying recurrence_id + occurrence_date. Unchecking it
// deletes that row, reverting the occurrence to a pending virtual to-do.

pub async fn complete_occurrence(
    user: AuthenticatedUser,
    path: web::Path<(Uuid, String)>,
    body: Option<web::Json<CompleteOccurrenceRequest>>,
    pool: web::Data<DbPool>,
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

    // Confirm the template belongs to the user before materializing.
    let template = match sqlx::query_as::<_, RecurringTask>(&format!(
        "SELECT {RECURRING_FIELDS} FROM db_recurring_tasks WHERE id = $1 AND user_id = $2"
    ))
    .bind(recurrence_id)
    .bind(&user.user_id)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(t)) => t,
        Ok(None) => return HttpResponse::NotFound().json(err("Recurring task not found")),
        Err(e) => {
            log::error!("recurring lookup failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to load recurring task"));
        }
    };

    if !done {
        // Undo: remove the materialized completion → occurrence goes back to virtual/pending.
        match sqlx::query(
            "DELETE FROM db_tasks WHERE recurrence_id = $1 AND occurrence_date = $2 AND user_id = $3",
        )
        .bind(recurrence_id)
        .bind(occurrence_date)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
        {
            Ok(_) => return HttpResponse::NoContent().finish(),
            Err(e) => {
                log::error!("occurrence uncomplete failed: {e}");
                return HttpResponse::InternalServerError()
                    .json(err("Failed to uncomplete occurrence"));
            }
        }
    }

    // Complete: idempotent upsert keyed by the unique (recurrence_id, occurrence_date).
    // due_at stays NULL — occurrence_date is the authoritative day the client uses
    // to place this completion on the calendar (in the user's local timezone).
    let sql = format!(
        "INSERT INTO db_tasks \
            (user_id, title, notes, done, completed_at, priority, tags, recurrence_id, occurrence_date) \
         VALUES ($1, $2, $3, TRUE, NOW(), $4, $5, $6, $7) \
         ON CONFLICT (recurrence_id, occurrence_date) \
         DO UPDATE SET done = TRUE, completed_at = NOW(), updated_at = NOW() \
         RETURNING {TASK_FIELDS}"
    );
    match sqlx::query_as::<_, Task>(&sql)
        .bind(&user.user_id)
        .bind(&template.title)
        .bind(&template.notes)
        .bind(template.priority)
        .bind(&template.tags)
        .bind(recurrence_id)
        .bind(occurrence_date)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(task) => HttpResponse::Ok().json(task),
        Err(e) => {
            log::error!("occurrence complete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to complete occurrence"))
        }
    }
}

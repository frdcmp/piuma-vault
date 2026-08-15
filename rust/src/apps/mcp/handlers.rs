//! Admin CRUD for MCP servers + test/health proxies to the mcp-worker.
//! All routes require `admin_access` — a server row is remote code the agent
//! can call (and, for stdio, code this stack executes).

use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use super::models::{CreateMcpServer, McpServer, McpServerResponse, UpdateMcpServer};
use crate::apps::agents::mcp as bridge;
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

const COLS: &str = "id, name, transport, url, auth_token, command, args, env, enabled, \
    cron_safe, timeout_secs, last_status, last_checked_at, tool_cache, created_at, updated_at";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(serde_json::json!({ "error": "admin_access required" }))
}
fn err(msg: impl Into<String>) -> serde_json::Value {
    serde_json::json!({ "error": msg.into() })
}

/// `name` becomes the tool-name namespace (`mcp__{name}__{tool}`), so it must
/// be a short slug the parser can split unambiguously: lowercase alphanumerics
/// with single `-`/`_` separators, and never a double underscore.
fn validate_name(name: &str) -> Result<(), String> {
    if name.is_empty() || name.len() > 32 {
        return Err("name must be 1–32 characters".to_string());
    }
    if name.contains("__") {
        return Err("name must not contain a double underscore".to_string());
    }
    if !name
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
    {
        return Err("name must be a slug: a-z, 0-9, '-', '_'".to_string());
    }
    Ok(())
}

fn validate_transport(transport: &str) -> Result<(), String> {
    match transport {
        "http" | "stdio" => Ok(()),
        other => Err(format!("unknown transport '{other}' (http | stdio)")),
    }
}

/// GET /admin/mcp/servers — list all servers (token masked, cached tool names).
pub async fn list_servers(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    match sqlx::query_as::<_, McpServer>(&format!("SELECT {COLS} FROM mcp_servers ORDER BY name"))
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => HttpResponse::Ok().json(
            rows.into_iter()
                .map(McpServerResponse::from)
                .collect::<Vec<_>>(),
        ),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// POST /admin/mcp/servers — create.
pub async fn create_server(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<CreateMcpServer>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let b = body.into_inner();
    let name = b.name.trim().to_string();
    if let Err(e) = validate_name(&name).and(validate_transport(&b.transport)) {
        return HttpResponse::BadRequest().json(err(e));
    }
    if b.transport == "http" && b.url.trim().is_empty() {
        return HttpResponse::BadRequest().json(err("url is required for http transport"));
    }
    if b.transport == "stdio" && b.command.trim().is_empty() {
        return HttpResponse::BadRequest().json(err("command is required for stdio transport"));
    }

    let row = sqlx::query_as::<_, McpServer>(&format!(
        "INSERT INTO mcp_servers \
           (name, transport, url, auth_token, command, args, env, enabled, cron_safe, timeout_secs) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING {COLS}"
    ))
    .bind(&name)
    .bind(&b.transport)
    .bind(b.url.trim())
    .bind(b.auth_token.trim())
    .bind(b.command.trim())
    .bind(&b.args)
    .bind(&b.env)
    .bind(b.enabled)
    .bind(b.cron_safe)
    .bind(b.timeout_secs.clamp(1, 600))
    .fetch_one(pool.get_ref())
    .await;

    match row {
        Ok(s) => HttpResponse::Created().json(McpServerResponse::from(s)),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            HttpResponse::Conflict().json(err(format!("a server named '{name}' already exists")))
        }
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// PUT /admin/mcp/servers/{id} — partial update (leave-token-blank-to-keep is
/// handled client-side by omitting the field; empty string clears).
pub async fn update_server(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
    body: web::Json<UpdateMcpServer>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let id = path.into_inner();
    let b = body.into_inner();

    let existing = match sqlx::query_as::<_, McpServer>(&format!(
        "SELECT {COLS} FROM mcp_servers WHERE id = $1"
    ))
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await
    {
        Ok(Some(s)) => s,
        Ok(None) => return HttpResponse::NotFound().json(err("server not found")),
        Err(e) => return HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    };

    let name = b
        .name
        .map(|n| n.trim().to_string())
        .unwrap_or(existing.name);
    let transport = b.transport.unwrap_or(existing.transport);
    if let Err(e) = validate_name(&name).and(validate_transport(&transport)) {
        return HttpResponse::BadRequest().json(err(e));
    }

    let row = sqlx::query_as::<_, McpServer>(&format!(
        "UPDATE mcp_servers SET name=$1, transport=$2, url=$3, auth_token=$4, command=$5, \
           args=$6, env=$7, enabled=$8, cron_safe=$9, timeout_secs=$10, updated_at=NOW() \
         WHERE id=$11 RETURNING {COLS}"
    ))
    .bind(&name)
    .bind(&transport)
    .bind(b.url.map(|u| u.trim().to_string()).unwrap_or(existing.url))
    .bind(b.auth_token.map(|t| t.trim().to_string()).unwrap_or(existing.auth_token))
    .bind(b.command.map(|c| c.trim().to_string()).unwrap_or(existing.command))
    .bind(b.args.unwrap_or(existing.args))
    .bind(b.env.unwrap_or(existing.env))
    .bind(b.enabled.unwrap_or(existing.enabled))
    .bind(b.cron_safe.unwrap_or(existing.cron_safe))
    .bind(b.timeout_secs.unwrap_or(existing.timeout_secs).clamp(1, 600))
    .bind(id)
    .fetch_one(pool.get_ref())
    .await;

    match row {
        Ok(s) => HttpResponse::Ok().json(McpServerResponse::from(s)),
        Err(sqlx::Error::Database(e)) if e.is_unique_violation() => {
            HttpResponse::Conflict().json(err(format!("a server named '{name}' already exists")))
        }
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// DELETE /admin/mcp/servers/{id}
pub async fn delete_server(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    match sqlx::query("DELETE FROM mcp_servers WHERE id = $1")
        .bind(path.into_inner())
        .execute(pool.get_ref())
        .await
    {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::NoContent().finish(),
        Ok(_) => HttpResponse::NotFound().json(err("server not found")),
        Err(e) => HttpResponse::InternalServerError().json(err(format!("DB error: {e}"))),
    }
}

/// POST /admin/mcp/servers/{id}/test — ask the worker to reconnect + re-list
/// the server's tools (also refreshes `tool_cache` / `last_status` on the row).
pub async fn test_server(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    let name: Option<String> = sqlx::query_scalar("SELECT name FROM mcp_servers WHERE id = $1")
        .bind(path.into_inner())
        .fetch_optional(pool.get_ref())
        .await
        .ok()
        .flatten();
    let Some(name) = name else {
        return HttpResponse::NotFound().json(err("server not found"));
    };
    match bridge::refresh(&name).await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => HttpResponse::BadGateway().json(err(e)),
    }
}

/// GET /admin/mcp/health — live connection state from the worker (status dots).
pub async fn worker_health(user: AuthenticatedUser) -> impl Responder {
    if !check_permission(&user, "admin_access") {
        return forbidden();
    }
    match bridge::health().await {
        Ok(v) => HttpResponse::Ok().json(v),
        Err(e) => HttpResponse::BadGateway().json(err(e)),
    }
}

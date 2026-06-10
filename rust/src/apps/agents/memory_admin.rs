//! Admin HTTP endpoints for the memory dashboard (`/admin/memory`). Read-only
//! views over the memory system plus a few moderation actions — the agent itself
//! manages memory through the `memory_*` / `context_*` tools; these endpoints let
//! a human scout and curate it.
//!
//! - L1 (always-in-context): `db_agent_profiles.memory` / `.user_context` + caps.
//! - L2/L4 (semantic + derived): `db_memory_entries` rows (embedding excluded).
//! - Phase 0 inspector: `db_agent_turn_logs` (what was retrieved each turn).

use actix_web::{web, HttpResponse, Responder};
use chrono::{DateTime, Utc};
use serde::Deserialize;
use serde_json::json;
use uuid::Uuid;

use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::models::ApiError;

// L1 caps mirror `tools::self_config`.
const MEMORY_CAP: i64 = 2200;
const USER_CONTEXT_CAP: i64 = 1375;

fn db_err(e: sqlx::Error) -> HttpResponse {
    log::error!("memory admin db error: {e}");
    HttpResponse::InternalServerError().json(ApiError::new("database error"))
}

#[derive(serde::Serialize, sqlx::FromRow)]
struct MemoryEntryOut {
    id: Uuid,
    agent: String,
    content: String,
    category: Option<String>,
    confidence: String,
    source: String,
    status: String,
    tags: Vec<String>,
    is_active: bool,
    embedded: bool,
    expires_at: Option<DateTime<Utc>>,
    created_at: DateTime<Utc>,
    updated_at: DateTime<Utc>,
}

#[derive(Deserialize)]
pub struct EntriesQuery {
    agent: Option<String>,
    status: Option<String>,
    source: Option<String>,
    category: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
    offset: Option<i64>,
}

/// GET /agents/memory/entries — filterable list of L2/L4 entries (embedding
/// omitted). Shows all statuses (incl. rejected) so the admin can audit.
pub async fn list_entries(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<EntriesQuery>,
) -> impl Responder {
    let limit = q.limit.unwrap_or(200).clamp(1, 1000);
    let offset = q.offset.unwrap_or(0).max(0);
    match sqlx::query_as::<_, MemoryEntryOut>(
        "SELECT id, agent, content, category, confidence, source, status, tags, is_active, \
                (embedding IS NOT NULL) AS embedded, expires_at, created_at, updated_at \
         FROM db_memory_entries \
         WHERE ($1::text IS NULL OR agent = $1) \
           AND ($2::text IS NULL OR status = $2) \
           AND ($3::text IS NULL OR source = $3) \
           AND ($4::text IS NULL OR category = $4) \
           AND ($5::text IS NULL OR content ILIKE '%' || $5 || '%') \
         ORDER BY created_at DESC LIMIT $6 OFFSET $7",
    )
    .bind(&q.agent)
    .bind(&q.status)
    .bind(&q.source)
    .bind(&q.category)
    .bind(&q.q)
    .bind(limit)
    .bind(offset)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => db_err(e),
    }
}

#[derive(Deserialize)]
pub struct AgentQuery {
    agent: Option<String>,
}

/// GET /agents/memory/overview — L1 usage + L2/L4 aggregate stats for one agent.
pub async fn overview(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<AgentQuery>,
) -> impl Responder {
    let agent = q.agent.clone().unwrap_or_else(|| "vault_agent".to_string());

    let l1: Option<(String, String)> =
        sqlx::query_as("SELECT memory, user_context FROM db_agent_profiles WHERE agent = $1")
            .bind(&agent)
            .fetch_optional(pool.get_ref())
            .await
            .unwrap_or(None);
    let (memory, user_context) = l1.unwrap_or_default();

    // Aggregate counts in one pass.
    let stats: Option<(i64, i64, i64, i64, i64, i64, i64, i64)> = sqlx::query_as(
        "SELECT \
           COUNT(*), \
           COUNT(*) FILTER (WHERE status = 'confirmed'), \
           COUNT(*) FILTER (WHERE status = 'pending'), \
           COUNT(*) FILTER (WHERE status = 'rejected'), \
           COUNT(*) FILTER (WHERE source = 'dialectic_derived'), \
           COUNT(*) FILTER (WHERE source = 'user_stated'), \
           COUNT(*) FILTER (WHERE source = 'agent_observed'), \
           COUNT(*) FILTER (WHERE embedding IS NULL AND is_active) \
         FROM db_memory_entries WHERE agent = $1 AND is_active",
    )
    .bind(&agent)
    .fetch_optional(pool.get_ref())
    .await
    .unwrap_or(None);
    let (total, confirmed, pending, rejected, derived, user_stated, agent_observed, unembedded) =
        stats.unwrap_or((0, 0, 0, 0, 0, 0, 0, 0));

    let by_category: Vec<(Option<String>, i64)> = sqlx::query_as(
        "SELECT category, COUNT(*) FROM db_memory_entries \
         WHERE agent = $1 AND is_active GROUP BY category ORDER BY COUNT(*) DESC",
    )
    .bind(&agent)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();
    let categories: Vec<_> = by_category
        .into_iter()
        .map(|(c, n)| json!({ "category": c.unwrap_or_else(|| "uncategorized".into()), "count": n }))
        .collect();

    // L3 conversation retrieval: how much chat history is searchable.
    let l3: Option<(i64, i64)> = sqlx::query_as(
        "SELECT \
           (SELECT COUNT(*) FROM db_chat_messages m \
              JOIN db_chat_conversations c ON c.id = m.conversation_id \
              WHERE c.agent = $1 AND m.role IN ('user', 'assistant')), \
           (SELECT COUNT(*) FROM db_chat_conversations WHERE agent = $1)",
    )
    .bind(&agent)
    .fetch_optional(pool.get_ref())
    .await
    .unwrap_or(None);
    let (l3_messages, l3_conversations) = l3.unwrap_or((0, 0));

    let mem_chars = memory.chars().count() as i64;
    let uc_chars = user_context.chars().count() as i64;
    HttpResponse::Ok().json(json!({
        "agent": agent,
        "l3": { "messages": l3_messages, "conversations": l3_conversations },
        "l1": {
            "memory": memory,
            "memory_chars": mem_chars,
            "memory_cap": MEMORY_CAP,
            "memory_pct": (mem_chars * 100 / MEMORY_CAP).min(100),
            "user_context": user_context,
            "user_context_chars": uc_chars,
            "user_context_cap": USER_CONTEXT_CAP,
            "user_context_pct": (uc_chars * 100 / USER_CONTEXT_CAP).min(100),
        },
        "stats": {
            "total": total,
            "by_status": { "confirmed": confirmed, "pending": pending, "rejected": rejected },
            "by_source": { "dialectic_derived": derived, "user_stated": user_stated, "agent_observed": agent_observed },
            "unembedded": unembedded,
            "by_category": categories,
        }
    }))
}

#[derive(Deserialize)]
pub struct TurnLogsQuery {
    agent: Option<String>,
    limit: Option<i64>,
}

#[derive(serde::Serialize, sqlx::FromRow)]
struct TurnLogOut {
    id: Uuid,
    conversation_id: Uuid,
    title: Option<String>,
    retrieved: serde_json::Value,
    l1_memory_chars: Option<i32>,
    l1_memory_pct: Option<i32>,
    created_at: DateTime<Utc>,
}

/// GET /agents/memory/turn-logs — Phase 0 inspector: what was retrieved per turn.
pub async fn turn_logs(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<TurnLogsQuery>,
) -> impl Responder {
    let limit = q.limit.unwrap_or(100).clamp(1, 500);
    match sqlx::query_as::<_, TurnLogOut>(
        "SELECT t.id, t.conversation_id, c.title, t.retrieved, t.l1_memory_chars, t.l1_memory_pct, t.created_at \
         FROM db_agent_turn_logs t \
         LEFT JOIN db_chat_conversations c ON c.id = t.conversation_id \
         WHERE ($1::text IS NULL OR t.agent = $1) \
         ORDER BY t.created_at DESC LIMIT $2",
    )
    .bind(&q.agent)
    .bind(limit)
    .fetch_all(pool.get_ref())
    .await
    {
        Ok(rows) => HttpResponse::Ok().json(rows),
        Err(e) => db_err(e),
    }
}

#[derive(Deserialize)]
pub struct ConvSearchQuery {
    agent: Option<String>,
    q: Option<String>,
    limit: Option<i64>,
}

/// GET /agents/memory/conversations?q= — L3 full-text search over chat history.
/// Same query the agent's `search_conversations` tool runs, for the dashboard.
pub async fn search_conversations(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<ConvSearchQuery>,
) -> impl Responder {
    let agent = q.agent.clone().unwrap_or_else(|| "vault_agent".to_string());
    let query = q.q.clone().unwrap_or_default();
    if query.trim().is_empty() {
        return HttpResponse::Ok().json(json!([]));
    }
    let limit = q.limit.unwrap_or(25).clamp(1, 100);
    match super::tools::conversations::search(pool.get_ref(), &agent, query.trim(), limit).await {
        Ok(hits) => HttpResponse::Ok().json(hits),
        Err(e) => {
            log::error!("memory admin conversation search: {e}");
            HttpResponse::InternalServerError().json(ApiError::new("search failed"))
        }
    }
}

// ── Moderation actions ───────────────────────────────────────────────────────

pub async fn confirm_entry(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let id = path.into_inner();
    match sqlx::query(
        "UPDATE db_memory_entries \
         SET status = 'confirmed', confidence = 'high', expires_at = NULL, is_active = TRUE, updated_at = NOW() \
         WHERE id = $1",
    )
    .bind(id)
    .execute(pool.get_ref())
    .await
    {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::Ok().json(json!({ "confirmed": true, "id": id })),
        Ok(_) => HttpResponse::NotFound().json(ApiError::new("entry not found")),
        Err(e) => db_err(e),
    }
}

pub async fn reject_entry(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let id = path.into_inner();
    match sqlx::query(
        "UPDATE db_memory_entries SET status = 'rejected', is_active = FALSE, updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .execute(pool.get_ref())
    .await
    {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::Ok().json(json!({ "rejected": true, "id": id })),
        Ok(_) => HttpResponse::NotFound().json(ApiError::new("entry not found")),
        Err(e) => db_err(e),
    }
}

/// DELETE /agents/memory/entries/{id} — hard delete (admin housekeeping).
pub async fn delete_entry(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    let id = path.into_inner();
    match sqlx::query("DELETE FROM db_memory_entries WHERE id = $1")
        .bind(id)
        .execute(pool.get_ref())
        .await
    {
        Ok(r) if r.rows_affected() > 0 => HttpResponse::Ok().json(json!({ "deleted": true, "id": id })),
        Ok(_) => HttpResponse::NotFound().json(ApiError::new("entry not found")),
        Err(e) => db_err(e),
    }
}

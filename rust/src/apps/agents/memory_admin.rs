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
    related_ids: Vec<Uuid>,
    contradicts_id: Option<Uuid>,
    source_conversation_id: Option<Uuid>,
    source_message_id: Option<Uuid>,
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
        "SELECT id, agent, content, category, confidence, source, status, tags, \
                related_ids, contradicts_id, source_conversation_id, source_message_id, is_active, \
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

/// GET /agents/memory/conversations?q= — L3 view for the dashboard. With a query
/// it runs the same full-text search the agent's `search_conversations` tool
/// uses; with an empty query it **browses** the agent's recent conversations
/// (so the tab shows the indexed history instead of sitting empty).
pub async fn search_conversations(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<ConvSearchQuery>,
) -> impl Responder {
    let agent = q.agent.clone().unwrap_or_else(|| "vault_agent".to_string());
    let query = q.q.clone().unwrap_or_default();
    let limit = q.limit.unwrap_or(25).clamp(1, 100);
    let result = if query.trim().is_empty() {
        super::tools::conversations::recent(pool.get_ref(), &agent, limit).await
    } else {
        super::tools::conversations::search(pool.get_ref(), &agent, query.trim(), limit).await
    };
    match result {
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

/// GET /agents/memory/entries/{id}/stats — computed corroboration metrics for
/// one entry: its nearest active neighbour by cosine distance, how that distance
/// sits against the dedup/corroboration thresholds (as a %), and the Stage-B NLI
/// verdict on the pair. This is exactly what governs whether a re-derivation of
/// this fact would be promoted to `confirmed`.
pub async fn entry_stats(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    path: web::Path<Uuid>,
) -> impl Responder {
    use crate::apps::agents::tools::memory;
    let id = path.into_inner();

    let entry: Option<(String, String, String, bool)> = sqlx::query_as(
        "SELECT agent, content, status, (embedding IS NOT NULL) FROM db_memory_entries WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(pool.get_ref())
    .await
    .unwrap_or(None);
    let Some((agent, content, status, embedded)) = entry else {
        return HttpResponse::NotFound().json(ApiError::new("entry not found"));
    };

    let thresholds = json!({
        "corroborate_distance": memory::CORROBORATE_DISTANCE,
        "dup_distance": memory::DUP_DISTANCE,
        "floor_confirmed": memory::FLOOR_CONFIRMED,
        "floor_pending": memory::FLOOR_PENDING,
    });

    if !embedded {
        return HttpResponse::Ok().json(json!({
            "id": id, "status": status, "embedded": false, "thresholds": thresholds,
            "nearest": serde_json::Value::Null,
            "note": "No embedding yet — distances can't be computed.",
        }));
    }

    // Nearest active neighbour (excluding self) by cosine distance to this
    // entry's stored embedding.
    let nearest: Option<(Uuid, String, String, String, f64)> = sqlx::query_as(
        "SELECT n.id, n.content, n.status, n.source, (n.embedding <=> e.embedding) AS dist \
         FROM db_memory_entries n, db_memory_entries e \
         WHERE e.id = $1 AND n.id <> $1 AND n.agent = $2 \
           AND n.is_active AND n.embedding IS NOT NULL \
         ORDER BY n.embedding <=> e.embedding LIMIT 1",
    )
    .bind(id)
    .bind(&agent)
    .fetch_optional(pool.get_ref())
    .await
    .unwrap_or(None);

    let Some((n_id, n_content, n_status, n_source, dist)) = nearest else {
        return HttpResponse::Ok().json(json!({
            "id": id, "status": status, "embedded": true, "thresholds": thresholds,
            "nearest": serde_json::Value::Null,
            "note": "No other embedded entries to compare against.",
        }));
    };

    let within_corroborate = dist < memory::CORROBORATE_DISTANCE;
    let within_dup = dist < memory::DUP_DISTANCE;
    // Positive = inside the corroboration band (close to promotable), negative =
    // outside, as a percentage of the threshold.
    let headroom_pct =
        (memory::CORROBORATE_DISTANCE - dist) / memory::CORROBORATE_DISTANCE * 100.0;

    // Stage-B NLI verdict on (this entry, nearest) — the same check the
    // corroboration path runs. Only run inside the band (an LLM call).
    let nli = if within_corroborate {
        memory::nli_check(pool.get_ref(), &content, &n_content).await
    } else {
        None
    };
    let would_corroborate = within_corroborate && nli == Some("entails");

    HttpResponse::Ok().json(json!({
        "id": id,
        "status": status,
        "embedded": true,
        "thresholds": thresholds,
        "nearest": {
            "id": n_id,
            "content": n_content,
            "status": n_status,
            "source": n_source,
            "distance": dist,
            "similarity_pct": (1.0 - dist) * 100.0,
        },
        "within_corroborate_band": within_corroborate,
        "within_dup_band": within_dup,
        "headroom_pct": headroom_pct,
        "nli": nli,
        "would_corroborate_on_rederive": would_corroborate,
    }))
}

#[derive(Deserialize)]
pub struct DedupQuery {
    agent: Option<String>,
    /// When false (default), returns the plan without mutating anything.
    apply: Option<bool>,
}

/// POST /agents/memory/dedup-pending — one-shot cleanup that collapses
/// near-duplicate **pending** entries the dialectic accumulated before/around
/// the corroboration fix. Mirrors the live corroboration logic: for each
/// cluster of pending entries within `CORROBORATE_DISTANCE` that Stage-B NLI
/// judges to `entails`, the oldest is kept and **promoted to confirmed**
/// (independent re-derivations = corroboration) and the rest are rejected and
/// linked to the survivor via `related_ids`. `?apply=false` (default) returns
/// the plan as a dry-run; `?apply=true` executes it.
pub async fn dedup_pending(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    q: web::Query<DedupQuery>,
) -> impl Responder {
    use crate::apps::agents::tools::memory;
    use std::collections::HashSet;

    let agent = q.agent.clone().unwrap_or_else(|| "vault_agent".to_string());
    let apply = q.apply.unwrap_or(false);
    const MAX_NLI: usize = 400; // safety cap on LLM calls per run

    // All active, embedded pending entries, oldest first (oldest = survivor).
    let entries: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, content FROM db_memory_entries \
         WHERE agent = $1 AND is_active AND status = 'pending' AND embedding IS NOT NULL \
         ORDER BY created_at ASC",
    )
    .bind(&agent)
    .fetch_all(pool.get_ref())
    .await
    .unwrap_or_default();

    let mut claimed: HashSet<Uuid> = HashSet::new();
    let mut clusters: Vec<serde_json::Value> = Vec::new();
    let mut nli_calls = 0usize;
    let mut nli_cap_hit = false;
    let mut absorbed_total = 0usize;

    for (sid, scontent) in &entries {
        if claimed.contains(sid) {
            continue;
        }
        claimed.insert(*sid);

        // Pending neighbours of the survivor within the corroboration band.
        let neighbours: Vec<(Uuid, String, f64)> = sqlx::query_as(
            "SELECT n.id, n.content, (n.embedding <=> s.embedding) AS dist \
             FROM db_memory_entries n, db_memory_entries s \
             WHERE s.id = $1 AND n.id <> $1 AND n.agent = $2 \
               AND n.is_active AND n.status = 'pending' AND n.embedding IS NOT NULL \
               AND (n.embedding <=> s.embedding) < $3 \
             ORDER BY n.embedding <=> s.embedding",
        )
        .bind(sid)
        .bind(&agent)
        .bind(memory::CORROBORATE_DISTANCE)
        .fetch_all(pool.get_ref())
        .await
        .unwrap_or_default();

        let mut absorbed: Vec<serde_json::Value> = Vec::new();
        for (nid, ncontent, dist) in neighbours {
            if claimed.contains(&nid) {
                continue;
            }
            if nli_calls >= MAX_NLI {
                nli_cap_hit = true;
                break;
            }
            nli_calls += 1;
            let verdict = memory::nli_check(pool.get_ref(), scontent, &ncontent).await;
            if verdict == Some("entails") {
                claimed.insert(nid);
                absorbed.push(json!({
                    "id": nid, "content": ncontent,
                    "distance": dist, "nli": "entails",
                }));
            }
        }

        if absorbed.is_empty() {
            continue;
        }
        absorbed_total += absorbed.len();

        if apply {
            // Promote survivor (corroborated by N independent re-derivations).
            let _ = sqlx::query(
                "UPDATE db_memory_entries \
                 SET status = 'confirmed', confidence = 'high', expires_at = NULL, updated_at = NOW() \
                 WHERE id = $1",
            )
            .bind(sid)
            .execute(pool.get_ref())
            .await;
            for a in &absorbed {
                let aid = a["id"].as_str().and_then(|s| Uuid::parse_str(s).ok());
                if let Some(aid) = aid {
                    let _ = sqlx::query(
                        "UPDATE db_memory_entries SET status = 'rejected', is_active = FALSE, updated_at = NOW() WHERE id = $1",
                    )
                    .bind(aid)
                    .execute(pool.get_ref())
                    .await;
                    let _ = sqlx::query(
                        "UPDATE db_memory_entries SET related_ids = array_append(related_ids, $2), updated_at = NOW() \
                         WHERE id = $1 AND NOT ($2 = ANY(related_ids))",
                    )
                    .bind(sid)
                    .bind(aid)
                    .execute(pool.get_ref())
                    .await;
                }
            }
        }

        clusters.push(json!({
            "survivor": { "id": sid, "content": scontent, "action": "promote to confirmed" },
            "absorbed": absorbed,
        }));
    }

    if nli_cap_hit {
        log::warn!("dedup_pending: NLI cap ({MAX_NLI}) hit — some candidates left unchecked");
    }
    HttpResponse::Ok().json(json!({
        "agent": agent,
        "apply": apply,
        "scanned": entries.len(),
        "nli_calls": nli_calls,
        "nli_cap_hit": nli_cap_hit,
        "clusters_found": clusters.len(),
        "entries_absorbed": absorbed_total,
        "clusters": clusters,
    }))
}

/// POST /agents/memory/test-derive — exercise the dialectic `save_derived`
/// path directly (admin testing utility): feeds a fact through the same
/// dedup/NLI/corroboration pipeline the post-turn dialectic uses and returns
/// the outcome (`inserted` | `corroborated` | `duplicate`).
#[derive(Deserialize)]
pub struct TestDeriveBody {
    content: String,
}

pub async fn test_derive(
    _user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<TestDeriveBody>,
) -> impl Responder {
    match super::tools::memory::save_derived(pool.get_ref(), "vault_agent", &body.content, Some("test"), None).await {
        Ok(outcome) => HttpResponse::Ok().json(json!({ "outcome": outcome })),
        Err(e) => HttpResponse::InternalServerError().json(json!({ "error": e })),
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

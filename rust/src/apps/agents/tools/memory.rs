//! L2 semantic memory tools — vector-searchable facts/preferences scoped per
//! agent. Entries live in `db_memory_entries`; embeddings are produced inline on
//! save/update (falling back to the `db_memory_embedding_jobs` queue when the
//! provider is unavailable) so a new fact is dedup-checked and searchable
//! immediately. Retrieval is cosine distance via pgvector.
//!
//! Also exposes `retrieve_for_turn` + `format_block`, used by the chat loop to
//! inject the top-K relevant memories into the system prompt (graded floor:
//! confirmed facts at distance < 0.5, pending/derived at the tighter < 0.3).

use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::apps::agents::providers;
use crate::apps::agents::models::{ModelRow, ProviderRow};
use crate::apps::embeddings;
use crate::db::db::DbPool;

const EMBED_DIMS: u32 = 1536;
/// Stage-A cosine-distance gate: a neighbour closer than this is "about the same
/// topic" and is treated as a duplicate on save. (Stage-B NLI — distinguishing
/// duplicate / contradiction / extension — lands with L4.)
const DUP_DISTANCE: f64 = 0.15;
/// Per-turn retrieval floors (cosine distance = 1 − similarity). Tuned loose so
/// related-but-not-identical facts actually surface (text-embedding-3-large puts
/// topical matches around 0.4–0.65 distance); tighten from the turn inspector if
/// retrieval gets noisy. Pending/derived facts use the stricter floor.
const FLOOR_CONFIRMED: f64 = 0.65;
const FLOOR_PENDING: f64 = 0.5;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "memory_search",
            "Search your long-term memory for facts/preferences relevant to a query. Returns the closest entries with their similarity, category, status, and provenance. Includes both confirmed facts and unconfirmed (derived) hypotheses.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "description": "max results (default 5)" }
                },
                "required": ["query"]
            }),
        ),
        (
            "memory_save",
            "Save a durable fact, preference, or observation to long-term memory. Runs a duplicate check first. Use for anything you'd only need when the topic comes up (use context_* tools for the few always-relevant facts).",
            json!({
                "type": "object",
                "properties": {
                    "content": { "type": "string", "description": "the fact, one self-contained statement" },
                    "category": { "type": "string", "description": "health | preferences | personal | work | convention | derived" },
                    "source": { "type": "string", "description": "user_stated = User told you directly or asked you to remember it; agent_observed = you inferred it. Set user_stated for things he says about himself — it's saved as high confidence. Default agent_observed." },
                    "confidence": { "type": "string", "description": "high | medium | low. Omit to let it default from source (user_stated→high, else medium)." },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["content"]
            }),
        ),
        (
            "memory_update",
            "Replace the content of an existing memory entry (re-embeds it).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string" },
                    "content": { "type": "string" }
                },
                "required": ["id", "content"]
            }),
        ),
        (
            "memory_delete",
            "Soft-delete a memory entry (it stops being retrieved).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        ),
        (
            "memory_list",
            "List your memory entries, most recent first. Optionally filter by category.",
            json!({
                "type": "object",
                "properties": {
                    "category": { "type": "string" },
                    "limit": { "type": "integer", "description": "default 20" }
                }
            }),
        ),
        (
            "memory_confirm",
            "Confirm a derived/pending memory entry (User affirmed it): promotes it to a normal fact (confidence high, no expiry).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        ),
        (
            "memory_reject",
            "Reject a derived/pending memory entry (User disagreed): it stops being retrieved.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        ),
        (
            "memory_related",
            "Return memory entries linked to the given entry via the related_ids graph (facts that extend or are compatible with it).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        ),
    ]
}

// ── Retrieval helper (used by the chat loop, not a tool) ─────────────────────

#[derive(Clone, Serialize)]
pub struct Retrieved {
    pub id: Uuid,
    pub content: String,
    pub status: String,
    pub source: String,
    pub distance: f64,
}

/// Top-K active memories for the given query, with a graded distance floor
/// (confirmed facts at < 0.5, pending at the tighter < 0.3) and confirmed
/// ranked first. Pass a `precomputed` embedding to skip the synchronous embed
/// call; falls back to embedding `query` inline if not provided.
/// Returns empty on any failure — retrieval is best-effort and never blocks the
/// turn.
pub async fn retrieve_for_turn(
    pool: &DbPool,
    agent: &str,
    precomputed: Option<&Vec<f32>>,
    query: &str,
    limit: i64,
) -> Vec<Retrieved> {
    let emb = match precomputed {
        Some(v) => v.clone(),
        None => match embeddings::embed(pool, query, EMBED_DIMS, "embedding:memory").await {
            Ok(e) => e,
            Err(_) => return Vec::new(),
        },
    };
    let vec = pgvector::Vector::from(emb);
    let rows: Vec<(Uuid, String, String, String, f64)> = sqlx::query_as(
        "SELECT id, content, status, source, (embedding <=> $2) AS dist \
         FROM db_memory_entries \
         WHERE agent = $1 AND is_active AND embedding IS NOT NULL \
           AND status IN ('confirmed', 'pending') \
           AND (expires_at IS NULL OR expires_at > NOW()) \
           AND (embedding <=> $2) < CASE WHEN status = 'confirmed' THEN $3 ELSE $4 END \
         ORDER BY (status = 'confirmed') DESC, embedding <=> $2 \
         LIMIT $5",
    )
    .bind(agent)
    .bind(&vec)
    .bind(FLOOR_CONFIRMED)
    .bind(FLOOR_PENDING)
    .bind(limit)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    rows.into_iter()
        .map(|(id, content, status, source, distance)| Retrieved { id, content, status, source, distance })
        .collect()
}

/// Render retrieved entries as a `# Relevant memories` system block with
/// provenance tags. Empty string when there's nothing to inject.
pub fn format_block(entries: &[Retrieved]) -> String {
    if entries.is_empty() {
        return String::new();
    }
    let mut s = String::from(
        "# Relevant memories\n\nRetrieved from your long-term memory by semantic relevance. \
         Entries tagged [derived, unconfirmed] are hypotheses — treat them as claims to verify, \
         not established facts.\n",
    );
    for e in entries {
        let tag = match (e.source.as_str(), e.status.as_str()) {
            (_, "pending") => "[derived, unconfirmed]",
            ("user_stated", _) => "[user-stated]",
            ("dialectic_derived", _) => "[derived]",
            _ => "[observed]",
        };
        s.push_str(&format!("- {tag} {}\n", e.content));
    }
    s
}

/// Stage-B NLI: send (new_fact, existing_fact) to a small model to judge the
/// semantic relationship. Returns `entails` (duplicate — existing already covers
/// the new), `contradicts`, or `neutral` (different but compatible). Uses the
/// default LLM provider/model; best-effort — falls back to cosine-only on any
/// failure.
async fn nli_check(pool: &DbPool, new_fact: &str, existing_fact: &str) -> Option<&'static str> {
    let model: ModelRow = sqlx::query_as(
        "SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1",
    )
    .fetch_optional(pool)
    .await
    .ok()??;
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await
        .ok()??;
    if !providers::supported(&provider.kind) || provider.api_key.trim().is_empty() {
        return None;
    }
    let prompt = format!(
        "You are a semantic comparison engine. Compare two facts and determine their relationship.\n\
         \nNEW FACT: {new_fact}\n\
         EXISTING FACT: {existing_fact}\n\
         \nDoes the NEW fact CONTRADICT, DUPLICATE (entail/say the same thing), or EXTEND \
         (different but compatible) the EXISTING fact?\n\
         Answer with exactly one word: entails | contradicts | neutral",
    );
    let messages = vec![serde_json::json!({ "role": "user", "content": prompt })];
    let raw = providers::complete(
        &provider.kind,
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        &messages,
        32,
    )
    .await
    .ok()?;
    let trimmed = raw.trim().to_lowercase();
    if trimmed.contains("entails") {
        Some("entails")
    } else if trimmed.contains("contradicts") || trimmed.contains("contradict") {
        Some("contradicts")
    } else if trimmed.contains("neutral") || trimmed.contains("extend") {
        Some("neutral")
    } else {
        // Model didn't follow the format — default to the safe choice: neutral
        // (save both; don't lose data on a misparse).
        Some("neutral")
    }
}

/// Append `new_id` to the `related_ids` array of `entry_id` (if not already
/// present). Used when NLI returns `neutral` to link extended/related facts.
async fn link_related(pool: &DbPool, entry_id: Uuid, new_id: Uuid) {
    let _ = sqlx::query(
        "UPDATE db_memory_entries \
         SET related_ids = array_append(related_ids, $2), updated_at = NOW() \
         WHERE id = $1 AND NOT ($2 = ANY(related_ids))",
    )
    .bind(entry_id)
    .bind(new_id)
    .execute(pool)
    .await;
}

/// Save a dialectic-derived fact as a low-trust pending entry (60-day TTL),
/// `source=dialectic_derived`, `confidence=medium`. Dedups against the agent's
/// active entries; if the nearest neighbour is a close match that is itself
/// pending, treat the re-derivation as corroboration and promote it to confirmed
/// instead of inserting a duplicate. If the nearest neighbour is confirmed and
/// close, runs Stage-B NLI to judge entail/contradict/neutral.
/// Returns the outcome label.
pub async fn save_derived(
    pool: &DbPool,
    agent: &str,
    content: &str,
    category: Option<&str>,
    conversation_id: Option<Uuid>,
) -> Result<&'static str, String> {
    let Ok(emb) = embeddings::embed(pool, content, EMBED_DIMS, "embedding:memory").await else {
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO db_memory_entries \
               (agent, content, category, confidence, source, status, source_conversation_id, expires_at) \
             VALUES ($1, $2, $3, 'medium', 'dialectic_derived', 'pending', $4, NOW() + INTERVAL '60 days') \
             RETURNING id",
        )
        .bind(agent)
        .bind(content)
        .bind(category)
        .bind(conversation_id)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        let _ = sqlx::query("INSERT INTO db_memory_embedding_jobs (memory_entry_id, content) VALUES ($1, $2)")
            .bind(id)
            .bind(content)
            .execute(pool)
            .await;
        return Ok("inserted");
    };

    let vec = pgvector::Vector::from(emb);
    let nearest: Option<(Uuid, f64, String)> = sqlx::query_as(
        "SELECT id, (embedding <=> $2) AS dist, status FROM db_memory_entries \
         WHERE agent = $1 AND is_active AND embedding IS NOT NULL \
         ORDER BY embedding <=> $2 LIMIT 1",
    )
    .bind(agent)
    .bind(&vec)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    if let Some((existing_id, dist, status)) = nearest {
        if dist < DUP_DISTANCE {
            if status == "pending" {
                // Corroboration: re-derivation confirms a pending fact.
                let _ = sqlx::query(
                    "UPDATE db_memory_entries \
                     SET confidence = 'high', status = 'confirmed', expires_at = NULL, updated_at = NOW() \
                     WHERE id = $1",
                )
                .bind(existing_id)
                .execute(pool)
                .await;
                return Ok("corroborated");
            }
            // Close match against a confirmed entry — run Stage-B NLI to
            // judge entail/contradict/neutral.
            let existing_content: Option<String> = sqlx::query_scalar(
                "SELECT content FROM db_memory_entries WHERE id = $1",
            )
            .bind(existing_id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
            if let Some(ref existing_content) = existing_content {
                if let Some(judgment) = nli_check(pool, content, existing_content).await {
                    match judgment {
                        "entails" => {
                            return Ok("duplicate");
                        }
                        "contradicts" => {
                            let new_id: Uuid = sqlx::query_scalar(
                                "INSERT INTO db_memory_entries \
                                   (agent, content, embedding, category, confidence, source, status, source_conversation_id, contradicts_id, expires_at) \
                                 VALUES ($1, $2, $3, $4, 'medium', 'dialectic_derived', 'pending', $5, $6, NOW() + INTERVAL '60 days') \
                                 RETURNING id",
                            )
                            .bind(agent)
                            .bind(content)
                            .bind(&vec)
                            .bind(category)
                            .bind(conversation_id)
                            .bind(existing_id)
                            .fetch_one(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                            let _ = sqlx::query(
                                "UPDATE db_memory_entries SET is_active = FALSE, updated_at = NOW() WHERE id = $1",
                            )
                            .bind(existing_id)
                            .execute(pool)
                            .await;
                            log::warn!(
                                "dialectic contradiction: new '{}' contradicts existing {} — \
                                 old deactivated, new saved as {}",
                                content, existing_id, new_id
                            );
                            return Ok("inserted");
                        }
                        _ => {
                            // neutral — save both, link via related_ids.
                            let new_id: Uuid = sqlx::query_scalar(
                                "INSERT INTO db_memory_entries \
                                   (agent, content, embedding, category, confidence, source, status, source_conversation_id, expires_at) \
                                 VALUES ($1, $2, $3, $4, 'medium', 'dialectic_derived', 'pending', $5, NOW() + INTERVAL '60 days') \
                                 RETURNING id",
                            )
                            .bind(agent)
                            .bind(content)
                            .bind(&vec)
                            .bind(category)
                            .bind(conversation_id)
                            .fetch_one(pool)
                            .await
                            .map_err(|e| e.to_string())?;
                            link_related(pool, existing_id, new_id).await;
                            link_related(pool, new_id, existing_id).await;
                            return Ok("inserted");
                        }
                    }
                }
            }
            // Fallback: no NLI available or couldn't fetch existing content.
            return Ok("duplicate");
        }
    }

    sqlx::query(
        "INSERT INTO db_memory_entries \
           (agent, content, embedding, category, confidence, source, status, source_conversation_id, expires_at) \
         VALUES ($1, $2, $3, $4, 'medium', 'dialectic_derived', 'pending', $5, NOW() + INTERVAL '60 days')",
    )
    .bind(agent)
    .bind(content)
    .bind(&vec)
    .bind(category)
    .bind(conversation_id)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok("inserted")
}

// ── Tools ────────────────────────────────────────────────────────────────────

pub async fn memory_save(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let content = req_str(args, "content")?;
    let category = opt_string(args, "category");
    let source = opt_string(args, "source").unwrap_or_else(|| "agent_observed".into());
    // Default confidence from source: a fact User stated directly is high;
    // something the agent merely inferred is medium.
    let confidence = opt_string(args, "confidence").unwrap_or_else(|| {
        if source == "user_stated" {
            "high".into()
        } else {
            "medium".into()
        }
    });
    let status = opt_string(args, "status").unwrap_or_else(|| "confirmed".into());
    let tags = opt_str_array(args, "tags").unwrap_or_default();

    let emb = embeddings::embed(pool, &content, EMBED_DIMS, "embedding:memory").await.ok();

    // Stage A — duplicate gate against the agent's active entries.
    if let Some(ref e) = emb {
        let vec = pgvector::Vector::from(e.clone());
        let dup: Option<(Uuid, String, f64)> = sqlx::query_as(
            "SELECT id, content, (embedding <=> $2) AS dist FROM db_memory_entries \
             WHERE agent = $1 AND is_active AND embedding IS NOT NULL \
             ORDER BY embedding <=> $2 LIMIT 1",
        )
        .bind(agent)
        .bind(&vec)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?;
        if let Some((id, existing, dist)) = dup {
            if dist < DUP_DISTANCE {
                return Ok(json!({
                    "duplicate": true,
                    "existing": { "id": id, "content": existing },
                    "distance": dist
                }));
            }
        }
    }

    let id: Uuid = if let Some(ref e) = emb {
        let vec = pgvector::Vector::from(e.clone());
        sqlx::query_scalar(
            "INSERT INTO db_memory_entries \
               (agent, content, embedding, category, confidence, source, status, tags) \
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
        )
        .bind(agent)
        .bind(&content)
        .bind(&vec)
        .bind(&category)
        .bind(&confidence)
        .bind(&source)
        .bind(&status)
        .bind(&tags)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        // Provider down: insert without an embedding and queue a backfill job.
        let id: Uuid = sqlx::query_scalar(
            "INSERT INTO db_memory_entries \
               (agent, content, category, confidence, source, status, tags) \
             VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id",
        )
        .bind(agent)
        .bind(&content)
        .bind(&category)
        .bind(&confidence)
        .bind(&source)
        .bind(&status)
        .bind(&tags)
        .fetch_one(pool)
        .await
        .map_err(|e| e.to_string())?;
        let _ = sqlx::query("INSERT INTO db_memory_embedding_jobs (memory_entry_id, content) VALUES ($1, $2)")
            .bind(id)
            .bind(&content)
            .execute(pool)
            .await;
        id
    };

    Ok(json!({ "saved": true, "id": id, "status": status }))
}

pub async fn memory_update(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let content = req_str(args, "content")?;
    let emb = embeddings::embed(pool, &content, EMBED_DIMS, "embedding:memory").await.ok();

    let affected = if let Some(e) = emb {
        let vec = pgvector::Vector::from(e);
        sqlx::query(
            "UPDATE db_memory_entries SET content = $3, embedding = $4, updated_at = NOW() \
             WHERE id = $1 AND agent = $2",
        )
        .bind(id)
        .bind(agent)
        .bind(&content)
        .bind(&vec)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected()
    } else {
        let n = sqlx::query(
            "UPDATE db_memory_entries SET content = $3, embedding = NULL, updated_at = NOW() \
             WHERE id = $1 AND agent = $2",
        )
        .bind(id)
        .bind(agent)
        .bind(&content)
        .execute(pool)
        .await
        .map_err(|e| e.to_string())?
        .rows_affected();
        let _ = sqlx::query("INSERT INTO db_memory_embedding_jobs (memory_entry_id, content) VALUES ($1, $2)")
            .bind(id)
            .bind(&content)
            .execute(pool)
            .await;
        n
    };
    if affected == 0 {
        return Err("memory entry not found".into());
    }
    Ok(json!({ "updated": true, "id": id }))
}

pub async fn memory_delete(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query(
        "UPDATE db_memory_entries SET is_active = FALSE, updated_at = NOW() WHERE id = $1 AND agent = $2",
    )
    .bind(id)
    .bind(agent)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();
    if affected == 0 {
        return Err("memory entry not found".into());
    }
    Ok(json!({ "deleted": true, "id": id }))
}

pub async fn memory_search(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let q = req_str(args, "query")?;
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).clamp(1, 20);
    let emb = embeddings::embed(pool, &q, EMBED_DIMS, "embedding:memory").await.ok();

    let rows: Vec<(Uuid, String, Option<String>, String, String, f64)> = if let Some(e) = emb {
        let vec = pgvector::Vector::from(e);
        sqlx::query_as(
            "SELECT id, content, category, status, source, (embedding <=> $2) AS dist \
             FROM db_memory_entries \
             WHERE agent = $1 AND is_active AND embedding IS NOT NULL \
               AND status IN ('confirmed', 'pending') \
               AND (expires_at IS NULL OR expires_at > NOW()) \
             ORDER BY embedding <=> $2 LIMIT $3",
        )
        .bind(agent)
        .bind(&vec)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        sqlx::query_as(
            "SELECT id, content, category, status, source, 1.0::float8 AS dist \
             FROM db_memory_entries \
             WHERE agent = $1 AND is_active AND status IN ('confirmed', 'pending') \
               AND (expires_at IS NULL OR expires_at > NOW()) \
             ORDER BY created_at DESC LIMIT $2",
        )
        .bind(agent)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    };

    let results: Vec<Value> = rows
        .into_iter()
        .map(|(id, content, category, status, source, dist)| {
            json!({
                "id": id,
                "content": content,
                "category": category,
                "status": status,
                "source": source,
                "similarity": (1.0 - dist).max(0.0)
            })
        })
        .collect();
    Ok(json!({ "results": results }))
}

pub async fn memory_list(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(20).clamp(1, 100);
    let category = opt_string(args, "category");
    let rows: Vec<(Uuid, String, Option<String>, String, String, String)> = sqlx::query_as(
        "SELECT id, content, category, confidence, status, source FROM db_memory_entries \
         WHERE agent = $1 AND is_active AND ($2::text IS NULL OR category = $2) \
         ORDER BY created_at DESC LIMIT $3",
    )
    .bind(agent)
    .bind(&category)
    .bind(limit)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let entries: Vec<Value> = rows
        .into_iter()
        .map(|(id, content, category, confidence, status, source)| {
            json!({ "id": id, "content": content, "category": category, "confidence": confidence, "status": status, "source": source })
        })
        .collect();
    Ok(json!({ "entries": entries }))
}

pub async fn memory_confirm(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query(
        "UPDATE db_memory_entries \
         SET status = 'confirmed', confidence = 'high', expires_at = NULL, updated_at = NOW() \
         WHERE id = $1 AND agent = $2",
    )
    .bind(id)
    .bind(agent)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();
    if affected == 0 {
        return Err("memory entry not found".into());
    }
    Ok(json!({ "confirmed": true, "id": id }))
}

pub async fn memory_reject(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let affected = sqlx::query(
        "UPDATE db_memory_entries SET status = 'rejected', is_active = FALSE, updated_at = NOW() \
         WHERE id = $1 AND agent = $2",
    )
    .bind(id)
    .bind(agent)
    .execute(pool)
    .await
    .map_err(|e| e.to_string())?
    .rows_affected();
    if affected == 0 {
        return Err("memory entry not found".into());
    }
    Ok(json!({ "rejected": true, "id": id }))
}

pub async fn memory_related(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let related: Option<Vec<Uuid>> = sqlx::query_scalar(
        "SELECT related_ids FROM db_memory_entries WHERE id = $1 AND agent = $2 AND is_active",
    )
    .bind(id)
    .bind(agent)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?
    .flatten();
    let ids = related.unwrap_or_default();
    if ids.is_empty() {
        return Ok(json!({ "entries": [] }));
    }
    let rows: Vec<(Uuid, String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT id, content, category, confidence, source FROM db_memory_entries \
         WHERE id = ANY($1) AND is_active ORDER BY created_at DESC",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let entries: Vec<Value> = rows
        .into_iter()
        .map(|(eid, content, category, confidence, source)| {
            json!({ "id": eid, "content": content, "category": category, "confidence": confidence, "source": source })
        })
        .collect();
    Ok(json!({ "entries": entries }))
}

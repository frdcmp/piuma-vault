//! L2 semantic memory tools — vector-searchable facts/preferences scoped per
//! agent. Entries live in `db_memory_entries`; embeddings are produced inline on
//! save/update (falling back to the `db_memory_embedding_jobs` queue when the
//! provider is unavailable) so a new fact is dedup-checked and searchable
//! immediately. Retrieval is cosine distance via pgvector.
//!
//! Also exposes `retrieve_for_turn` + `format_block`, used by the chat loop to
//! inject the top-K relevant memories into the system prompt (graded floor:
//! confirmed facts at distance < FLOOR_CONFIRMED, pending at the tighter
//! FLOOR_PENDING).
//!
//! A fact is about the user (`contact_id` NULL: what Piuma knows and retrieves each turn) or
//! about one of the people they talk to (`user_id`, `contact_id`: what Pigeon learns from their
//! conversations, `pigeon::known`), under the same rules; Piuma reads those only when asked
//! (`memory_search` with `person`).
//!
//! A pending fact earns trust only from the user or from independent evidence:
//! the user confirms it (`confirm`, `confirmed_by` user or chat), or the
//! dialectic derives it again from another conversation at least a day later
//! (corroborated). A derived fact never switches off a confirmed one: one that
//! contradicts it waits, pending, for the user. A confirmed goal holds GOAL_DAYS
//! from when it last came up; other confirmed facts don't expire.

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
pub const DUP_DISTANCE: f64 = 0.15;
/// Cosine pre-filter for corroboration: a new dialectic derivation within this
/// distance of an existing entry is a *candidate* same-fact rewording and is
/// handed to Stage-B NLI for the actual keep/merge decision. Real cross-session
/// re-derivations of one fact paraphrase heavily (subject + framing shift, e.g.
/// "User aims to maintain an NBA calendar" vs "User prefers NBA games added
/// to their calendar") and drift as far as ~0.40 — so this gate is deliberately
/// loose. It is only a cheap pre-filter to bound NLI calls, NOT the decision:
/// NLI separates true rewordings (`entails`) from mere topical siblings
/// (`neutral`, e.g. Monday vs Tuesday workout at ~0.21). DUP_DISTANCE stays
/// strict for direct save-dedup, where there's no NLI backstop.
///
/// Tuned to 0.40 after a 0.45 sweep: even with the same-fact NLI prompt, pairs
/// at 0.40–0.45 produced a tail of over-merges (distinct facts the prompt
/// stretched to "same"); every clean merge sat at ≤0.37, so 0.40 keeps the wins
/// and drops the questionable tail.
pub const CORROBORATE_DISTANCE: f64 = 0.40;
/// Per-turn retrieval floors (cosine distance = 1 − similarity).
/// text-embedding-3-large puts topical matches around 0.4–0.65; at 0.65 two
/// thirds of what the turn inspector showed injected sat at 0.55 or more, loosely
/// related at best, so confirmed facts stop at 0.55. Pending facts use the
/// stricter floor.
pub const FLOOR_CONFIRMED: f64 = 0.55;
pub const FLOOR_PENDING: f64 = 0.5;
/// Ranking: a confirmed fact counts as this much closer than it is, so it wins
/// over a guess about as close, never over a much closer one.
pub const CONFIRMED_BONUS: f64 = 0.05;
/// A confirmed goal ("User is working toward X") holds this many days from when
/// it last came up (confirmed, or derived again); then it stops being retrieved
/// and the worker's sweep switches it off.
pub const GOAL_DAYS: i32 = 60;
/// A re-derivation corroborates a pending fact only this many days or more
/// after it was written, and from another conversation.
pub const INDEPENDENT_DAYS: i32 = 1;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "memory_search",
            "Search your long-term memory for facts/preferences relevant to a query. Returns the closest entries with their similarity, category, status, and provenance. Includes both confirmed facts and unconfirmed (derived) hypotheses. About the user by default; with `person`, what Pigeon knows about one of the people they talk to (learnt from their conversations).",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "person": { "type": "string", "description": "a contact's name or @slug: search what is known about them instead of about the user" },
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
                    "source": { "type": "string", "description": "user_stated = the user told you directly or asked you to remember it; agent_observed = you inferred it. Set user_stated for things they say about themselves — it's saved as high confidence. Default agent_observed." },
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
            "Confirm a derived/pending memory entry (the user affirmed it): promotes it to a normal fact (confidence high, no expiry).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string" } },
                "required": ["id"]
            }),
        ),
        (
            "memory_reject",
            "Reject a derived/pending memory entry (the user disagreed): it stops being retrieved.",
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
/// (FLOOR_CONFIRMED, the tighter FLOOR_PENDING), closest first with confirmed
/// facts CONFIRMED_BONUS closer. Pass a `precomputed` embedding to skip the synchronous embed
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
         WHERE agent = $1 AND contact_id IS NULL AND is_active AND embedding IS NOT NULL \
           AND status IN ('confirmed', 'pending') \
           AND (expires_at IS NULL OR expires_at > NOW()) \
           AND (embedding <=> $2) < CASE WHEN status = 'confirmed' THEN $3 ELSE $4 END \
         ORDER BY (embedding <=> $2) - CASE WHEN status = 'confirmed' THEN $6 ELSE 0 END \
         LIMIT $5",
    )
    .bind(agent)
    .bind(&vec)
    .bind(FLOOR_CONFIRMED)
    .bind(FLOOR_PENDING)
    .bind(limit)
    .bind(CONFIRMED_BONUS)
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

/// Stage-B NLI: send (new_fact, existing_fact) to the default model to judge the
/// relationship. Framed as **same-underlying-fact** detection (not strict
/// logical entailment): returns `entails` when both capture the same fact even
/// if reworded, `contradicts` when they conflict, or `neutral` when they're
/// genuinely different facts. Best-effort — falls back to cosine-only on failure.
pub async fn nli_check(pool: &DbPool, new_fact: &str, existing_fact: &str) -> Option<&'static str> {
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
        "You compare two memory entries about the same user and decide whether they \
         capture the SAME underlying fact.\n\
         \nENTRY A: {existing_fact}\n\
         ENTRY B: {new_fact}\n\
         \nReply with EXACTLY one word:\n\
         - entails — A and B are the SAME underlying fact, preference, goal, or habit, \
         even if worded very differently, written about \"the user\" vs a name, framed as \
         a preference vs a goal, or one is slightly more specific. \
         (e.g. \"User aims to keep an accurate NBA calendar\" and \"User prefers NBA \
         games auto-added to their calendar\" → entails.)\n\
         - contradicts — they make conflicting claims (one negates, reverses, or updates the other).\n\
         - neutral — they are DIFFERENT facts, even if on the same topic. \
         (e.g. \"trains chest on Monday\" vs \"trains back on Tuesday\" → neutral.)\n\
         \nAnswer with exactly one word: entails | contradicts | neutral",
    );
    let messages = vec![serde_json::json!({ "role": "user", "content": prompt })];
    // Generous budget: the default model may be a reasoning model whose
    // thinking eats the budget before the one-word answer (see dialectic.rs).
    let raw = providers::complete(
        &provider.kind,
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        &messages,
        4000,
    )
    .await
    .ok()?;
    let trimmed = raw.trim().to_lowercase();
    log::info!(
        "nli: new '{}' vs existing '{}' -> '{}'",
        new_fact,
        existing_fact,
        raw.trim()
    );
    if trimmed.is_empty() {
        // Reasoning exhausted the budget / provider returned nothing — treat
        // as NLI-unavailable, not as a neutral judgment.
        return None;
    }
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

/// Whom a fact is about, when it isn't the user: one of their contacts (Pigeon's facts about
/// the people they talk to). Piuma's facts about the user have no contact.
#[derive(Clone, Copy, Debug)]
pub struct Person<'a> {
    pub user: &'a str,
    pub contact: Uuid,
}

/// A fact to write, derived from conversations: Piuma's dialectic (about the user, from a chat)
/// or Pigeon (about a person, `stated` when they said it about themselves).
struct Derived<'a> {
    agent: &'a str,
    content: &'a str,
    category: Option<&'a str>,
    /// the Piuma chat it came from
    conversation_id: Option<Uuid>,
    about: Option<Person<'a>>,
    stated: bool,
}

/// Insert a derived fact. A guess is pending for 60 days (`dialectic_derived` about the user,
/// `pigeon_derived` about a person); what a person said about themselves (`person_stated`) is
/// confirmed at once, unless it contradicts a confirmed fact (`contradicts_id`), which only the
/// user settles. No embedding (the provider is down): one is queued.
async fn insert_derived(pool: &DbPool, d: &Derived<'_>, vec: Option<&pgvector::Vector>, contradicts_id: Option<Uuid>, waits: bool) -> Result<Uuid, String> {
    let confirmed = d.stated && !waits;
    let source = match (d.about, d.stated) {
        (None, _) => "dialectic_derived",
        (Some(_), true) => "person_stated",
        (Some(_), false) => "pigeon_derived",
    };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_memory_entries \
           (agent, user_id, contact_id, content, embedding, category, confidence, source, status, source_conversation_id, contradicts_id, \
            confirmed_by, confirmed_at, expires_at) \
         VALUES ($1, $2, $3, $4, $5, $6, CASE WHEN $9 THEN 'high' ELSE 'medium' END, $7, CASE WHEN $9 THEN 'confirmed' ELSE 'pending' END, $8, $10, \
                 CASE WHEN $9 THEN 'stated' END, CASE WHEN $9 THEN NOW() END, \
                 CASE WHEN NOT $9 THEN NOW() + INTERVAL '60 days' WHEN $6 = 'goal' THEN NOW() + make_interval(days => $11) END) \
         RETURNING id",
    )
    .bind(d.agent)
    .bind(d.about.map(|p| p.user))
    .bind(d.about.map(|p| p.contact))
    .bind(d.content)
    .bind(vec)
    .bind(d.category)
    .bind(source)
    .bind(d.conversation_id)
    .bind(confirmed)
    .bind(contradicts_id)
    .bind(GOAL_DAYS)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    if vec.is_none() {
        let _ = sqlx::query("INSERT INTO db_memory_embedding_jobs (memory_entry_id, content) VALUES ($1, $2)").bind(id).bind(d.content).execute(pool).await;
    }
    Ok(id)
}

/// Confirm an entry: trusted, high confidence, and `by` says how: `user` (on
/// the dashboard), `chat` (the agent, on the user's word), `corroborated`
/// (derived again, independently). A goal holds GOAL_DAYS from now, anything
/// else never expires. Confirming a fact settles the one it contradicts: that
/// one is switched off. False: no such entry (of this agent, when one is given).
pub async fn confirm(pool: &DbPool, id: Uuid, agent: Option<&str>, by: &str) -> Result<bool, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let settled: Option<Option<Uuid>> = sqlx::query_scalar(
        "UPDATE db_memory_entries \
         SET status = 'confirmed', confidence = 'high', is_active = TRUE, confirmed_by = $3, confirmed_at = NOW(), \
             expires_at = CASE WHEN category = 'goal' THEN NOW() + make_interval(days => $4) END, updated_at = NOW() \
         WHERE id = $1 AND ($2::text IS NULL OR agent = $2) \
         RETURNING contradicts_id",
    )
    .bind(id)
    .bind(agent)
    .bind(by)
    .bind(GOAL_DAYS)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(contradicts) = settled else {
        return Ok(false);
    };
    if let Some(old) = contradicts {
        sqlx::query("UPDATE db_memory_entries SET is_active = FALSE, updated_at = NOW() WHERE id = $1").bind(old).execute(&mut *tx).await?;
    }
    tx.commit().await?;
    Ok(true)
}

/// A confirmed goal came up again: it holds GOAL_DAYS from now.
pub async fn renew(pool: &DbPool, id: Uuid) {
    let _ = sqlx::query(
        "UPDATE db_memory_entries SET expires_at = NOW() + make_interval(days => $2), updated_at = NOW() \
         WHERE id = $1 AND status = 'confirmed' AND category = 'goal'",
    )
    .bind(id)
    .bind(GOAL_DAYS)
    .execute(pool)
    .await;
}

/// Save a dialectic-derived fact about the user as a low-trust pending entry (60-day TTL),
/// `source=dialectic_derived`, `confidence=medium`, from the Piuma chat `conversation_id`.
/// Returns the outcome label (`save`).
pub async fn save_derived(
    pool: &DbPool,
    agent: &str,
    content: &str,
    category: Option<&str>,
    conversation_id: Option<Uuid>,
) -> Result<&'static str, String> {
    save(pool, &Derived { agent, content, category, conversation_id, about: None, stated: false }).await
}

/// Save what Pigeon learnt about a person from their conversations: `stated` when they said it
/// about themselves (confirmed), else a guess (pending). Returns the outcome label (`save`).
pub async fn save_about(pool: &DbPool, agent: &str, person: Person<'_>, content: &str, category: Option<&str>, stated: bool) -> Result<&'static str, String> {
    save(pool, &Derived { agent, content, category, conversation_id: None, about: Some(person), stated }).await
}

/// Dedups against the active facts about the same subject (the user, or the one person): any
/// neighbour within CORROBORATE_DISTANCE is judged by Stage-B NLI.
///   - `entails`: the same fact. About the user, it corroborates a pending neighbour when the
///     two are independent (another conversation, INDEPENDENT_DAYS apart); about a person, when
///     they said it themselves. Either way not when the neighbour contradicts a fact still held.
///     Otherwise a duplicate (a confirmed goal is renewed).
///   - `contradicts`: supersedes a pending neighbour; beside a confirmed one it waits, pending,
///     for the user.
///   - `neutral`: both kept, linked via `related_ids`.
///
/// With NLI unavailable, cosine alone is trusted only below DUP_DISTANCE.
async fn save(pool: &DbPool, d: &Derived<'_>) -> Result<&'static str, String> {
    let Ok(emb) = embeddings::embed(pool, d.content, EMBED_DIMS, "embedding:memory").await else {
        insert_derived(pool, d, None, None, false).await?;
        return Ok("inserted");
    };

    let vec = pgvector::Vector::from(emb);
    // the nearest held fact about the same subject; `independent`: written in another
    // conversation, at least INDEPENDENT_DAYS ago (so the same chat, or the agent repeating it,
    // can't confirm it); `disputed`: it contradicts a fact still held
    let nearest: Option<(Uuid, f64, String, String, bool, bool)> = sqlx::query_as(
        "SELECT e.id, (e.embedding <=> $2) AS dist, e.status, e.content, \
                (e.source_conversation_id IS DISTINCT FROM $3 AND e.created_at < NOW() - make_interval(days => $4)) AS independent, \
                EXISTS (SELECT 1 FROM db_memory_entries c WHERE c.id = e.contradicts_id AND c.is_active) AS disputed \
         FROM db_memory_entries e \
         WHERE e.agent = $1 AND e.contact_id IS NOT DISTINCT FROM $5 AND e.is_active AND e.embedding IS NOT NULL \
         ORDER BY e.embedding <=> $2 LIMIT 1",
    )
    .bind(d.agent)
    .bind(&vec)
    .bind(d.conversation_id)
    .bind(INDEPENDENT_DAYS)
    .bind(d.about.map(|p| p.contact))
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    let content = d.content;
    if let Some((existing_id, dist, status, existing_content, independent, disputed)) = nearest {
        if dist < CORROBORATE_DISTANCE {
            let judgment = nli_check(pool, content, &existing_content).await;
            // the same fact (NLI unavailable: near-verbatim cosine alone is trustworthy)
            if judgment == Some("entails") || (judgment.is_none() && dist < DUP_DISTANCE) {
                // Corroboration: derived again, independently, or said by the person themselves.
                let (confirms, by) = match d.about {
                    None => (independent, "corroborated"),
                    Some(_) => (d.stated, "stated"),
                };
                if status == "pending" && confirms && !disputed {
                    confirm(pool, existing_id, None, by).await.map_err(|e| e.to_string())?;
                    log::info!("memory corroboration ({by}): '{content}' (dist {dist:.3}) confirms pending {existing_id}");
                    return Ok("corroborated");
                }
                if status == "confirmed" {
                    renew(pool, existing_id).await;
                }
                return Ok("duplicate");
            }
            match judgment {
                Some("contradicts") => {
                    // a guess replaces a guess; a confirmed fact stays until the user confirms the new one
                    let waits = status != "pending";
                    let new_id = insert_derived(pool, d, Some(&vec), Some(existing_id), waits).await?;
                    if waits {
                        log::warn!("memory contradiction: new '{content}' contradicts confirmed {existing_id}: saved pending as {new_id}, for the user");
                    } else {
                        let _ = sqlx::query("UPDATE db_memory_entries SET is_active = FALSE, updated_at = NOW() WHERE id = $1")
                            .bind(existing_id)
                            .execute(pool)
                            .await;
                        log::warn!("memory contradiction: new '{content}' supersedes pending {existing_id}, saved as {new_id}");
                    }
                    return Ok("inserted");
                }
                Some(_) => {
                    // neutral — save both, link via related_ids.
                    let new_id = insert_derived(pool, d, Some(&vec), None, false).await?;
                    link_related(pool, existing_id, new_id).await;
                    link_related(pool, new_id, existing_id).await;
                    return Ok("inserted");
                }
                None => {
                    // NLI unavailable in the wide band — could be a sibling
                    // fact, don't guess: fall through to a plain insert.
                }
            }
        }
    }

    insert_derived(pool, d, Some(&vec), None, false).await?;
    Ok("inserted")
}

// ── Tools ────────────────────────────────────────────────────────────────────

pub async fn memory_save(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let content = req_str(args, "content")?;
    let category = opt_string(args, "category");
    let source = opt_string(args, "source").unwrap_or_else(|| "agent_observed".into());
    // Default confidence from source: a fact the user stated directly is high;
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
             WHERE agent = $1 AND contact_id IS NULL AND is_active AND embedding IS NOT NULL \
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

/// The contacts a name or @slug names (the vault is one user's: the agents app has no other).
async fn people_named(pool: &DbPool, who: &str) -> Result<Vec<(Uuid, String)>, String> {
    let who = who.trim().trim_start_matches('@');
    let found: Vec<(Uuid, String)> = sqlx::query_as(
        "SELECT id, COALESCE(name, slug, id::text) FROM db_pigeon_contacts \
         WHERE lower(slug) = lower($1) OR name ILIKE '%' || $1 || '%' ORDER BY (lower(slug) = lower($1)) DESC LIMIT 5",
    )
    .bind(who)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    if found.is_empty() {
        return Err(format!("no contact named {who}"));
    }
    Ok(found)
}

pub async fn memory_search(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let q = req_str(args, "query")?;
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5).clamp(1, 20);
    // about the user (no contact), or about the people named
    let people = match opt_string(args, "person") {
        Some(who) => Some(people_named(pool, &who).await?),
        None => None,
    };
    let contacts: Option<Vec<Uuid>> = people.as_ref().map(|p| p.iter().map(|(id, _)| *id).collect());
    let emb = embeddings::embed(pool, &q, EMBED_DIMS, "embedding:memory").await.ok();

    let rows: Vec<(Uuid, String, Option<String>, String, String, Option<Uuid>, f64)> = if let Some(e) = emb {
        let vec = pgvector::Vector::from(e);
        sqlx::query_as(
            "SELECT id, content, category, status, source, contact_id, (embedding <=> $2) AS dist \
             FROM db_memory_entries \
             WHERE agent = $1 AND is_active AND embedding IS NOT NULL \
               AND CASE WHEN $4::uuid[] IS NULL THEN contact_id IS NULL ELSE contact_id = ANY($4) END \
               AND status IN ('confirmed', 'pending') \
               AND (expires_at IS NULL OR expires_at > NOW()) \
             ORDER BY embedding <=> $2 LIMIT $3",
        )
        .bind(agent)
        .bind(&vec)
        .bind(limit)
        .bind(&contacts)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        sqlx::query_as(
            "SELECT id, content, category, status, source, contact_id, 1.0::float8 AS dist \
             FROM db_memory_entries \
             WHERE agent = $1 AND is_active AND status IN ('confirmed', 'pending') \
               AND CASE WHEN $3::uuid[] IS NULL THEN contact_id IS NULL ELSE contact_id = ANY($3) END \
               AND (expires_at IS NULL OR expires_at > NOW()) \
             ORDER BY created_at DESC LIMIT $2",
        )
        .bind(agent)
        .bind(limit)
        .bind(&contacts)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    };

    let name_of = |id: Option<Uuid>| people.as_ref().and_then(|p| p.iter().find(|(c, _)| Some(*c) == id).map(|(_, n)| n.clone()));
    let results: Vec<Value> = rows
        .into_iter()
        .map(|(id, content, category, status, source, contact, dist)| {
            json!({
                "id": id,
                "about": name_of(contact),
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
         WHERE agent = $1 AND contact_id IS NULL AND is_active AND ($2::text IS NULL OR category = $2) \
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
    // the agent confirms on the user's word in the chat
    if !confirm(pool, id, Some(agent), "chat").await.map_err(|e| e.to_string())? {
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

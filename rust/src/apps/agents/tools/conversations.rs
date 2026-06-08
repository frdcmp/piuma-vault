//! L3 conversation retrieval — Postgres full-text search over past chat history.
//!
//! Every message stores a `content_text` mirror of its text blocks; Postgres
//! derives `content_tsv` (a GENERATED tsvector) and a partial GIN index covers
//! user + assistant turns. This module searches that index and aggregates hits
//! to the conversation level (best-ranked snippet + match count per thread).
//!
//! On-demand only — unlike L1/L2 it is never auto-injected; the agent calls
//! `search_conversations` when it needs to recall what was actually said.

use serde_json::{json, Value};

use super::*;
use crate::db::db::DbPool;

/// Build a prefix-aware tsquery expression (mirrors the notes search). Returns a
/// SQL fragment like `to_tsquery('english', 'nas:* & backup:*')`, with the user
/// input escaped — safe to interpolate into the query string.
fn tsquery_expr(q: &str) -> String {
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|tok| {
            tok.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .map(|clean| format!("{}:*", clean.replace('\'', "''")))
        .collect();
    if terms.is_empty() {
        format!("plainto_tsquery('english', '{}')", q.replace('\'', "''"))
    } else {
        format!("to_tsquery('english', '{}')", terms.join(" & "))
    }
}

/// One conversation-level hit. `snippet` is a ts_headline excerpt around the
/// match (keywords wrapped in « »); `matches` is how many messages in that
/// thread matched.
#[derive(serde::Serialize, sqlx::FromRow)]
pub struct ConversationHit {
    pub conversation_id: uuid::Uuid,
    pub title: Option<String>,
    pub role: String,
    pub snippet: String,
    pub matches: i64,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

/// Full-text search over a single agent's chat history, aggregated to the
/// conversation level and ranked by relevance. Shared by the agent tool and the
/// admin dashboard.
pub async fn search(
    pool: &DbPool,
    agent: &str,
    query: &str,
    limit: i64,
) -> Result<Vec<ConversationHit>, String> {
    let tsq = tsquery_expr(query);
    // `q` holds the tsquery once; `hits` finds matching user/assistant turns;
    // `ranked` keeps the best-ranked message per conversation (with a headline
    // excerpt); `counts` totals matches per conversation.
    let sql = format!(
        r#"
        WITH q AS (SELECT {tsq} AS query),
        hits AS (
            SELECT c.id AS conversation_id, c.title, m.role, m.content_text, m.created_at,
                   ts_rank(m.content_tsv, q.query) AS rank
            FROM db_chat_messages m
            JOIN db_chat_conversations c ON c.id = m.conversation_id
            CROSS JOIN q
            WHERE c.agent = $1
              AND m.role IN ('user', 'assistant')
              AND m.content_tsv @@ q.query
        ),
        ranked AS (
            SELECT DISTINCT ON (h.conversation_id)
                   h.conversation_id, h.title, h.role, h.created_at, h.rank,
                   ts_headline('english', h.content_text, q.query,
                       'MaxFragments=2,MinWords=4,MaxWords=18,StartSel=«,StopSel=»') AS snippet
            FROM hits h CROSS JOIN q
            ORDER BY h.conversation_id, h.rank DESC
        ),
        counts AS (
            SELECT conversation_id, COUNT(*) AS matches FROM hits GROUP BY conversation_id
        )
        SELECT r.conversation_id, r.title, r.role, r.snippet, cnt.matches, r.created_at
        FROM ranked r
        JOIN counts cnt USING (conversation_id)
        ORDER BY r.rank DESC
        LIMIT $2
        "#
    );

    sqlx::query_as::<_, ConversationHit>(&sql)
        .bind(agent)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())
}

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "search_conversations",
        "Full-text search over your PAST conversations with the user. Use this to \
         recall what was actually said — e.g. when the user references an earlier \
         discussion (\"what did we decide about X?\", \"remember when…\") or you need \
         to recover context from an old thread. Returns the matching conversations \
         with a highlighted snippet, the match count, and a date. Complements your \
         long-term memory (memory_search), which only holds distilled facts — this \
         searches the verbatim transcript. Not for the current conversation (you \
         already have that in context).",
        json!({
            "type": "object",
            "properties": {
                "query": { "type": "string", "description": "keywords to search for" },
                "limit": { "type": "integer", "description": "max conversations to return (default 8, max 25)" }
            },
            "required": ["query"]
        }),
    )]
}

/// Tool entry point. Scoped to the active agent's own conversations.
pub async fn search_conversations(pool: &DbPool, agent: &str, args: &Value) -> Result<Value, String> {
    let query = req_str(args, "query")?;
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(8)
        .clamp(1, 25);

    let hits = search(pool, agent, &query, limit).await?;
    let results: Vec<Value> = hits
        .into_iter()
        .map(|h| {
            json!({
                "conversation_id": h.conversation_id,
                "title": h.title.unwrap_or_else(|| "(untitled)".to_string()),
                "matched_role": h.role,
                "snippet": h.snippet,
                "matches": h.matches,
                "date": h.created_at.to_rfc3339(),
            })
        })
        .collect();
    Ok(json!({ "count": results.len(), "results": results }))
}

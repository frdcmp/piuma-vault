//! Final-pass summarisation. Resolves the default LLM (same selection the chat
//! path uses), turns the full transcript into a structured markdown summary,
//! saves it as a vault note, and links the note back onto the session row.
//!
//! Reuses `agents::providers::complete` rather than any hardcoded provider, so
//! the summariser follows whatever model is configured in admin → Agents.

use uuid::Uuid;

use crate::apps::agents::models::{ModelRow, ProviderRow};
use crate::apps::agents::providers;
use crate::db::db::DbPool;

use super::session;

const SYSTEM: &str = "You summarise a meeting or voice-memo transcript into a \
clean markdown note. Structure it as: a one-paragraph Summary, a Key Points \
bullet list, and an Action Items checklist (`- [ ] ...`). Be faithful to the \
transcript; do not invent decisions or names. Reply with ONLY the markdown \
body — no preamble, no code fences. Use the transcript's language.";

// Budget must cover the default model's reasoning tokens too (it's a reasoning
// model), or `content` comes back empty. Generous cap for a full summary.
const MAX_TOKENS: u32 = 4096;

/// Summarise `transcript` for session `id`, save a note, and finalize the row.
/// On any failure the session is marked `failed` and the error returned.
pub async fn run(
    pool: &DbPool,
    id: Uuid,
    user_id: &str,
    title: &str,
    transcript: &str,
) -> Result<Uuid, String> {
    if transcript.trim().is_empty() {
        let msg = "empty transcript — nothing to summarise".to_string();
        session::mark_failed(pool, id, &msg).await;
        return Err(msg);
    }

    let summary = match summarise(pool, transcript).await {
        Ok(s) => s,
        Err(e) => {
            session::mark_failed(pool, id, &e).await;
            return Err(e);
        }
    };

    // Stamp the note title with the recording's start time (UTC) so multiple
    // recordings — especially untitled ones — never collide. Format: `ddmmyyyy
    // HHMMSS`, e.g. "Recording — 12062026 143501".
    let recorded_at: Option<chrono::DateTime<chrono::Utc>> =
        sqlx::query_scalar("SELECT created_at FROM db_recording_sessions WHERE id = $1")
            .bind(id)
            .fetch_optional(pool)
            .await
            .ok()
            .flatten();
    let stamp = recorded_at
        .unwrap_or_else(chrono::Utc::now)
        .format("%d%m%Y %H%M%S")
        .to_string();
    let base = if title.trim().is_empty() {
        "Recording"
    } else {
        title.trim()
    };
    let note_title = format!("{base} — {stamp}");
    let content = format!("# {note_title}\n\n{summary}\n");

    // Create the vault note + queue it for embedding (semantic search parity
    // with hand-written notes).
    let note_id: Uuid = match sqlx::query_scalar(
        "INSERT INTO notes (user_id, title, content, tags, folder) \
         VALUES ($1, $2, $3, ARRAY['recording'], '/recordings') RETURNING id",
    )
    .bind(user_id)
    .bind(&note_title)
    .bind(&content)
    .fetch_one(pool)
    .await
    {
        Ok(nid) => nid,
        Err(e) => {
            let msg = format!("note insert failed: {e}");
            session::mark_failed(pool, id, &msg).await;
            return Err(msg);
        }
    };
    let _ = sqlx::query("INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)")
        .bind(note_id)
        .bind(&content)
        .execute(pool)
        .await;

    let _ = sqlx::query(
        "UPDATE db_recording_sessions \
         SET status = 'done', final_note_id = $2, running_summary = $3, updated_at = NOW() \
         WHERE id = $1",
    )
    .bind(id)
    .bind(note_id)
    .bind(&summary)
    .execute(pool)
    .await;

    Ok(note_id)
}

/// One-shot LLM summarisation against the default configured model.
async fn summarise(pool: &DbPool, transcript: &str) -> Result<String, String> {
    let model: ModelRow =
        sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool)
            .await
            .ok()
            .flatten()
            .ok_or_else(|| "no default LLM model configured (admin → Agents)".to_string())?;
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await
        .ok()
        .flatten()
        .ok_or_else(|| "default model's provider not found".to_string())?;
    if !providers::supported(&provider.kind) || provider.api_key.trim().is_empty() {
        return Err("default LLM provider is not usable (missing key / unsupported)".to_string());
    }

    let messages = vec![
        serde_json::json!({ "role": "system", "content": SYSTEM }),
        serde_json::json!({ "role": "user", "content": format!("Transcript:\n\n{transcript}") }),
    ];

    let raw = providers::complete(
        &provider.kind,
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        &messages,
        MAX_TOKENS,
    )
    .await?;

    let summary = raw.trim().to_string();
    if summary.is_empty() {
        return Err("summariser returned empty content".to_string());
    }
    Ok(summary)
}

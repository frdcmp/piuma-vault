//! Recording tools — read access to the recorder's transcript corpus, plus a
//! way to kick off a new capture. The agent CANNOT record audio itself (no
//! microphone server-side); `start_recording` just creates a session and hands
//! back a deep-link the user opens to actually capture. The valuable tools are
//! the retrieval ones: list sessions and read a transcript + summary.

use super::*;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "list_recordings",
            "List recording sessions (meetings, voice memos) newest-first, with title, status, date, duration, and a transcript preview. Use to find a recording before reading it.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "optional case-insensitive filter over title + preview" },
                    "limit": { "type": "integer", "description": "max sessions (default 20, max 100)" }
                }
            }),
        ),
        (
            "get_recording",
            "Read one recording's summary and full transcript by session id. The transcript is the verbatim text; the summary is the saved note. Use after list_recordings.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "recording session UUID" } },
                "required": ["id"]
            }),
        ),
        (
            "start_recording",
            "Create a new recording session and return a link the user opens to start capturing audio. The agent cannot record audio itself — this only sets up the session.",
            json!({
                "type": "object",
                "properties": { "title": { "type": "string", "description": "optional title for the recording" } }
            }),
        ),
    ]
}

pub async fn list_recordings(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let limit = args
        .get("limit")
        .and_then(|v| v.as_i64())
        .unwrap_or(20)
        .clamp(1, 100);
    let query = opt_string(args, "query")
        .map(|q| q.trim().to_lowercase())
        .filter(|q| !q.is_empty());

    let rows: Vec<(uuid::Uuid, String, String, i32, i32, String, Option<chrono::DateTime<chrono::Utc>>)> =
        sqlx::query_as(
            "SELECT id, title, status, duration_secs, word_count, preview, created_at \
             FROM db_recording_sessions WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2",
        )
        .bind(user_id)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("list failed: {e}"))?;

    let items: Vec<Value> = rows
        .into_iter()
        .filter(|(_, title, _, _, _, preview, _)| match &query {
            Some(q) => title.to_lowercase().contains(q) || preview.to_lowercase().contains(q),
            None => true,
        })
        .map(|(id, title, status, duration, words, preview, created)| {
            json!({
                "id": id,
                "title": title,
                "status": status,
                "duration_secs": duration,
                "word_count": words,
                "preview": preview,
                "created_at": created,
            })
        })
        .collect();

    Ok(json!({ "count": items.len(), "recordings": items }))
}

pub async fn get_recording(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;

    let row: Option<(String, String, Option<String>, Option<String>, Option<uuid::Uuid>)> =
        sqlx::query_as(
            "SELECT title, status, transcript_storage_key, running_summary, final_note_id \
             FROM db_recording_sessions WHERE id = $1 AND user_id = $2",
        )
        .bind(id)
        .bind(user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| format!("lookup failed: {e}"))?;
    let Some((title, status, key, summary, note_id)) = row else {
        return Err("recording not found".to_string());
    };

    // Pull the JSONL transcript from S3 and flatten to plain text.
    let transcript = match key {
        Some(k) => fetch_transcript(pool, &k).await.unwrap_or_default(),
        None => String::new(),
    };

    Ok(json!({
        "id": id,
        "title": title,
        "status": status,
        "summary": summary,
        "note_id": note_id,
        "transcript": transcript,
    }))
}

pub async fn start_recording(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let title = opt_string(args, "title").unwrap_or_default();
    let provider = crate::apps::settings::store::get(
        pool,
        crate::apps::settings::store::TRANSCRIPTION_PROVIDER,
    )
    .await
    .unwrap_or_else(|| "speechmatics".to_string());

    let id: uuid::Uuid = sqlx::query_scalar(
        "INSERT INTO db_recording_sessions (user_id, title, provider) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(user_id)
    .bind(title.trim())
    .bind(&provider)
    .fetch_one(pool)
    .await
    .map_err(|e| format!("could not create session: {e}"))?;

    Ok(json!({
        "session_id": id,
        "url": format!("/recorder?session={id}"),
        "note": "Open this link to start capturing audio — the agent cannot record on its own.",
    }))
}

/// Download the transcript JSONL from S3 and join the segment texts into plain
/// readable text.
async fn fetch_transcript(pool: &DbPool, key: &str) -> Result<String, String> {
    let (client, bucket) = crate::apps::storage::handlers::s3_client(pool).await?;
    let out = client
        .get_object()
        .bucket(&bucket)
        .key(key)
        .send()
        .await
        .map_err(|e| format!("transcript fetch failed: {e}"))?;
    let bytes = out
        .body
        .collect()
        .await
        .map_err(|e| format!("transcript read failed: {e}"))?
        .into_bytes();
    let jsonl = String::from_utf8_lossy(&bytes);

    let text = jsonl
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|v| v.get("text").and_then(|t| t.as_str()).map(|s| s.to_string()))
        .collect::<Vec<_>>()
        .join(" ");
    Ok(text)
}

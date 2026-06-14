//! Notes tools — read (search / read / folders / tags) and write (create /
//! update / append). Writes re-enqueue an embedding job so vector search stays
//! current, mirroring the notes HTTP handlers.

use serde_json::{json, Value};
use uuid::Uuid;

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "search_notes",
            "Search the user's notes by meaning and keywords (hybrid: vector similarity + full-text + fuzzy title). Returns id, title, folder and a snippet for each hit. Use this FIRST for anything that might be written down; one good query usually suffices — re-phrasing rarely surfaces new notes.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string", "description": "keywords to search for" },
                    "limit": { "type": "integer", "description": "max results (default 8, max 25)" }
                },
                "required": ["query"]
            }),
        ),
        (
            "read_note",
            "Read a note's full content by its id (get the id from search_notes first).",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "note UUID — must come from a prior search_notes / read_note / browse_folder result; never invent or guess it" } },
                "required": ["id"]
            }),
        ),
        (
            "list_folders",
            "List all of the user's note folders.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "browse_folder",
            "List the notes and immediate subfolders inside a folder path.",
            json!({
                "type": "object",
                "properties": { "path": { "type": "string", "description": "folder path, e.g. /projects/example" } },
                "required": ["path"]
            }),
        ),
        (
            "search_folders",
            "Find folders whose path matches a query, with the note count in each.",
            json!({
                "type": "object",
                "properties": { "query": { "type": "string", "description": "folder name fragment" } },
                "required": ["query"]
            }),
        ),
        (
            "list_tags",
            "List all distinct tags used across the user's notes.",
            json!({ "type": "object", "properties": {} }),
        ),
        (
            "create_note",
            "Create a new note. Returns the new note id.",
            json!({
                "type": "object",
                "properties": {
                    "title": { "type": "string" },
                    "content": { "type": "string", "description": "markdown body" },
                    "folder": { "type": "string", "description": "folder path (default '/'). Verify the path against search_folders/list_folders first; reuse an existing folder and match it verbatim rather than creating a near-duplicate." },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["title", "content"]
            }),
        ),
        (
            "update_note",
            "Update an existing note. Only the provided fields change; content fully replaces the body (use append_to_note to add).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "note UUID — must come from a prior search_notes / read_note / browse_folder result; never invent or guess it" },
                    "title": { "type": "string" },
                    "content": { "type": "string" },
                    "folder": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["id"]
            }),
        ),
        (
            "append_to_note",
            "Append text to the end of a note's body (adds a blank line first).",
            json!({
                "type": "object",
                "properties": {
                    "id": { "type": "string", "description": "note UUID — must come from a prior search_notes / read_note / browse_folder result; never invent or guess it" },
                    "text": { "type": "string", "description": "markdown to append" }
                },
                "required": ["id", "text"]
            }),
        ),
        (
            "delete_note",
            "Move a note to the trash (soft delete — recoverable). Confirm with the user before deleting.",
            json!({
                "type": "object",
                "properties": { "id": { "type": "string", "description": "note UUID — must come from a prior search_notes / read_note / browse_folder result; never invent or guess it" } },
                "required": ["id"]
            }),
        ),
    ]
}

// Best-effort re-embed so vector search reflects new/updated content.
async fn enqueue_embedding(pool: &DbPool, note_id: Uuid, content: &str) {
    let _ = sqlx::query("DELETE FROM embedding_jobs WHERE note_id = $1")
        .bind(note_id)
        .execute(pool)
        .await;
    let _ = sqlx::query("INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)")
        .bind(note_id)
        .bind(content)
        .execute(pool)
        .await;
}

pub async fn search_notes(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    use crate::apps::embeddings;

    let q = req_str(args, "query")?;
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(8).clamp(1, 25);

    // Prefix-aware tsquery so partial words ("decalitr") still match indexed
    // lexemes ("decalitro") — mirrors the notes HTTP search handler.
    let terms: Vec<String> = q
        .split_whitespace()
        .map(|tok| tok.chars().filter(|c| c.is_alphanumeric() || *c == '_').collect::<String>())
        .filter(|s| !s.is_empty())
        .map(|clean| format!("{}:*", clean.replace('\'', "''")))
        .collect();
    let tsquery = if terms.is_empty() {
        format!("plainto_tsquery('english', '{}')", q.replace('\'', "''"))
    } else {
        format!("to_tsquery('english', '{}')", terms.join(" & "))
    };
    let search_esc = q.replace('\'', "''");

    // A query embedding unlocks hybrid (vector) search; if it can't be produced
    // (provider down / unconfigured) we fall back to FTS-only, then substring.
    let emb = embeddings::embed(pool, &q, 1536, "embedding:search").await.ok();

    let rows: Vec<(Uuid, String, String, Option<String>)> = if let Some(emb) = emb {
        let vec_str = format!("[{}]", emb.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","));
        // Reciprocal-rank-fusion over three candidate pools (FTS / vector /
        // fuzzy-title), k = 60. user_id is bound; the rest is escaped above.
        let sql = format!(
            r#"
            WITH
            fts AS (
                SELECT id, title, COALESCE(folder, '/') AS folder, left(content, 240) AS snippet,
                       ROW_NUMBER() OVER (ORDER BY ts_rank(content_tsv, {tsq}) DESC) AS rn
                FROM notes WHERE user_id = $1 AND deleted_at IS NULL AND content_tsv @@ {tsq}
                LIMIT 50
            ),
            vec AS (
                SELECT id, title, COALESCE(folder, '/') AS folder, left(content, 240) AS snippet,
                       ROW_NUMBER() OVER (ORDER BY (embedding <=> '{vec}'::vector) ASC) AS rn
                FROM notes WHERE user_id = $1 AND deleted_at IS NULL AND embedding IS NOT NULL
                LIMIT 50
            ),
            tri AS (
                SELECT id, title, COALESCE(folder, '/') AS folder, left(content, 240) AS snippet,
                       ROW_NUMBER() OVER (ORDER BY similarity(title, '{search}') DESC) AS rn
                FROM notes WHERE user_id = $1 AND deleted_at IS NULL AND title % '{search}'
                LIMIT 50
            ),
            combined AS (
                SELECT id, title, folder, snippet, 1.0 / (60 + rn) AS s FROM fts
                UNION ALL SELECT id, title, folder, snippet, 1.0 / (60 + rn) FROM vec
                UNION ALL SELECT id, title, folder, snippet, 1.0 / (60 + rn) FROM tri
            )
            SELECT id, title, folder, MAX(snippet) AS snippet
            FROM combined
            GROUP BY id, title, folder
            ORDER BY SUM(s) DESC
            LIMIT $2
            "#,
            tsq = tsquery,
            vec = vec_str,
            search = search_esc,
        );
        sqlx::query_as(&sql).bind(user_id).bind(limit).fetch_all(pool).await.map_err(|e| e.to_string())?
    } else {
        let sql = format!(
            "SELECT id, title, COALESCE(folder, '/'), left(content, 240) FROM notes \
             WHERE user_id = $1 AND deleted_at IS NULL AND content_tsv @@ {tsq} \
             ORDER BY ts_rank(content_tsv, {tsq}) DESC, updated_at DESC LIMIT $2",
            tsq = tsquery,
        );
        sqlx::query_as(&sql).bind(user_id).bind(limit).fetch_all(pool).await.map_err(|e| e.to_string())?
    };

    // Last-resort substring match: catches queries with no indexed lexemes (and
    // no embedding) so the tool never silently returns nothing it could've found.
    let rows = if rows.is_empty() {
        let like = format!("%{q}%");
        sqlx::query_as::<_, (Uuid, String, String, Option<String>)>(
            "SELECT id, title, COALESCE(folder, '/'), left(content, 240) FROM notes \
             WHERE user_id = $1 AND deleted_at IS NULL AND (title ILIKE $2 OR content ILIKE $2) \
             ORDER BY updated_at DESC LIMIT $3",
        )
        .bind(user_id)
        .bind(&like)
        .bind(limit)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?
    } else {
        rows
    };

    let count = rows.len();
    let results: Vec<Value> = rows
        .into_iter()
        .map(|(id, title, folder, snippet)| {
            json!({ "id": id, "title": title, "folder": folder, "snippet": snippet.unwrap_or_default() })
        })
        .collect();
    Ok(json!({ "count": count, "results": results }))
}

pub async fn read_note(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let row: Option<(String, String, String, Vec<String>)> = sqlx::query_as(
        "SELECT title, content, COALESCE(folder, '/'), tags FROM notes \
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((title, content, folder, tags)) => {
            Ok(json!({ "title": title, "content": content, "folder": folder, "tags": tags }))
        }
        None => Err("note not found for that id — call search_notes to get the correct id, then retry".into()),
    }
}

pub async fn list_folders(pool: &DbPool, user_id: &str) -> Result<Value, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT COALESCE(folder, '/') FROM notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY 1",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({ "folders": rows.into_iter().map(|(f,)| f).collect::<Vec<_>>() }))
}

pub async fn browse_folder(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let path = req_str(args, "path")?;
    // Notes whose folder is exactly this path.
    let files: Vec<(Uuid, String, Vec<String>)> = sqlx::query_as(
        "SELECT id, title, tags FROM notes \
         WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(folder, '/') = $2 \
         ORDER BY updated_at DESC LIMIT 200",
    )
    .bind(user_id)
    .bind(&path)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;

    // Immediate subfolders: distinct folders that start with `path/`.
    let child_prefix = format!("{}/", path.trim_end_matches('/'));
    let like = format!("{child_prefix}%");
    let folder_rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT COALESCE(folder, '/') FROM notes \
         WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(folder, '/') LIKE $2",
    )
    .bind(user_id)
    .bind(&like)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let mut subfolders: Vec<String> = folder_rows
        .into_iter()
        .filter_map(|(f,)| {
            f.strip_prefix(&child_prefix)
                .and_then(|rest| rest.split('/').next())
                .filter(|s| !s.is_empty())
                .map(|s| format!("{child_prefix}{s}"))
        })
        .collect();
    subfolders.sort();
    subfolders.dedup();

    let files: Vec<Value> = files
        .into_iter()
        .map(|(id, title, tags)| json!({ "id": id, "title": title, "tags": tags }))
        .collect();
    Ok(json!({ "path": path, "subfolders": subfolders, "notes": files }))
}

pub async fn search_folders(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let q = req_str(args, "query")?;
    let like = format!("%{q}%");
    let rows: Vec<(String, i64)> = sqlx::query_as(
        "SELECT COALESCE(folder, '/'), COUNT(*)::BIGINT FROM notes \
         WHERE user_id = $1 AND deleted_at IS NULL AND COALESCE(folder, '/') ILIKE $2 \
         GROUP BY 1 ORDER BY 1 LIMIT 50",
    )
    .bind(user_id)
    .bind(&like)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    let folders: Vec<Value> = rows
        .into_iter()
        .map(|(folder, count)| json!({ "folder": folder, "note_count": count }))
        .collect();
    Ok(json!({ "folders": folders }))
}

pub async fn list_tags(pool: &DbPool, user_id: &str) -> Result<Value, String> {
    let rows: Vec<(String,)> = sqlx::query_as(
        "SELECT DISTINCT UNNEST(tags) AS tag FROM notes WHERE user_id = $1 AND deleted_at IS NULL ORDER BY tag",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await
    .map_err(|e| e.to_string())?;
    Ok(json!({ "tags": rows.into_iter().map(|(t,)| t).collect::<Vec<_>>() }))
}

pub async fn create_note(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let title = req_str(args, "title")?;
    let content = args.get("content").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let folder = opt_string(args, "folder").unwrap_or_else(|| "/".to_string());
    let tags = opt_str_array(args, "tags").unwrap_or_default();
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO notes (user_id, title, content, tags, folder) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(user_id)
    .bind(&title)
    .bind(&content)
    .bind(&tags)
    .bind(&folder)
    .fetch_one(pool)
    .await
    .map_err(|e| e.to_string())?;
    enqueue_embedding(pool, id, &content).await;
    Ok(json!({ "id": id, "title": title, "folder": folder }))
}

pub async fn update_note(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let title = opt_string(args, "title");
    let content = opt_string(args, "content");
    let folder = opt_string(args, "folder");
    let tags = opt_str_array(args, "tags");
    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        "UPDATE notes SET \
           title = COALESCE($3, title), \
           content = COALESCE($4, content), \
           folder = COALESCE($5, folder), \
           tags = COALESCE($6, tags), \
           updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL \
         RETURNING id, title, content",
    )
    .bind(id)
    .bind(user_id)
    .bind(&title)
    .bind(&content)
    .bind(&folder)
    .bind(&tags)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, new_content)) => {
            if content.is_some() {
                enqueue_embedding(pool, id, &new_content).await;
            }
            Ok(json!({ "id": id, "title": title, "updated": true }))
        }
        None => Err("note not found for that id — call search_notes to get the correct id, then retry".into()),
    }
}

pub async fn append_to_note(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let text = req_str(args, "text")?;
    let row: Option<(Uuid, String, String)> = sqlx::query_as(
        "UPDATE notes SET content = content || E'\\n\\n' || $3, updated_at = NOW() \
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL \
         RETURNING id, title, content",
    )
    .bind(id)
    .bind(user_id)
    .bind(&text)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title, new_content)) => {
            enqueue_embedding(pool, id, &new_content).await;
            Ok(json!({ "id": id, "title": title, "appended": true }))
        }
        None => Err("note not found for that id — call search_notes to get the correct id, then retry".into()),
    }
}

pub async fn delete_note(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let id = uuid_arg(args, "id")?;
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE notes SET deleted_at = NOW() \
         WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING id, title",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(pool)
    .await
    .map_err(|e| e.to_string())?;
    match row {
        Some((id, title)) => {
            let _ = sqlx::query("DELETE FROM embedding_jobs WHERE note_id = $1")
                .bind(id)
                .execute(pool)
                .await;
            Ok(json!({ "id": id, "title": title, "trashed": true }))
        }
        None => Err("note not found for that id — call search_notes to get the correct id, then retry".into()),
    }
}

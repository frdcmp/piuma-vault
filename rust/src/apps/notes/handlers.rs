use actix_web::{web, HttpResponse, Responder};
use uuid::Uuid;

use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::db::db::DbPool;

use super::events::{NoteAction, NotesEventBus};
use super::models::{
    CreateNoteRequest, ListNotesQuery, Note, NoteListItem, NoteListResponse, NotesApiError,
    RenameFolderRequest, UpdateNoteRequest,
};

const NOTE_FIELDS: &str =
    "id, user_id, title, content, tags, folder, created_at, updated_at";

const LIST_FIELDS: &str =
    "id, title, tags, folder, created_at, updated_at";

fn err(msg: impl Into<String>) -> NotesApiError {
    NotesApiError {
        error: msg.into(),
    }
}

fn require_read(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if !check_permission(user, "notes.read") {
        Some(HttpResponse::Forbidden().json(err("Access denied: notes.read permission required")))
    } else {
        None
    }
}

fn require_write(user: &AuthenticatedUser) -> Option<HttpResponse> {
    if !check_permission(user, "notes.write") {
        Some(HttpResponse::Forbidden().json(err("Access denied: notes.write permission required")))
    } else {
        None
    }
}

// ── VALIDATION ────────────────────────────────────────────────────────────

fn validate_note(title: &str, content: &str, tags: &[String], folder: &str) -> Option<HttpResponse> {
    if title.trim().is_empty() {
        return Some(HttpResponse::BadRequest().json(err("Title is required")));
    }
    if title.len() > 500 {
        return Some(HttpResponse::BadRequest().json(err("Title must be 500 chars or fewer")));
    }
    if content.len() > 1_000_000 {
        return Some(HttpResponse::BadRequest().json(err("Content must be 1MB or fewer")));
    }
    if tags.len() > 20 {
        return Some(HttpResponse::BadRequest().json(err("Maximum 20 tags per note")));
    }
    for tag in tags {
        if tag.len() > 50 {
            return Some(HttpResponse::BadRequest().json(err(format!("Tag '{}' exceeds 50 characters", tag))));
        }
        if tag.chars().any(|c| c.is_uppercase() || c.is_whitespace()) {
            return Some(HttpResponse::BadRequest().json(err(format!("Tag '{}' must be lowercase with no spaces", tag))));
        }
    }
    if folder.len() > 255 {
        return Some(HttpResponse::BadRequest().json(err("Folder path must be 255 chars or fewer")));
    }
    if !folder.starts_with('/') {
        return Some(HttpResponse::BadRequest().json(err("Folder must start with /")));
    }
    None
}

// ── LIST NOTES ────────────────────────────────────────────────────────────

pub async fn list_notes(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<ListNotesQuery>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }

	let limit = query.limit.unwrap_or(50).clamp(1, 10000);
    let offset = query.offset.unwrap_or(0).max(0);

    // Count query
    let count_sql = "SELECT COUNT(*) FROM notes WHERE user_id = $1";
    let total: (i64,) = match sqlx::query_as(count_sql)
        .bind(&user.user_id)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(c) => c,
        Err(e) => {
            log::error!("notes count failed: {e}");
            return HttpResponse::InternalServerError().json(err("Failed to count notes"));
        }
    };

    // Build data query with optional search, folder, tag filters
    if let Some(ref search) = query.search {
        if !search.trim().is_empty() {
            return list_with_search(&user, &pool, search, query.folder.as_deref(), query.tag.as_deref(), limit, offset).await;
        }
    }

    let mut where_clauses = vec!["user_id = $1".to_string()];
    let mut params: Vec<String> = vec![];
    let mut idx = 2u32;

    if let Some(ref folder) = query.folder {
        params.push(folder.clone());
        where_clauses.push(format!("folder = ${}", idx));
        idx += 1;
    }
    if let Some(ref tag) = query.tag {
        params.push(tag.clone());
        where_clauses.push(format!("${} = ANY(tags)", idx));
        idx += 1;
    }

    let where_sql = where_clauses.join(" AND ");

    let data_sql = format!(
        "SELECT {} FROM notes WHERE {} ORDER BY updated_at DESC LIMIT ${} OFFSET ${}",
        LIST_FIELDS, where_sql, idx, idx + 1
    );

    let mut q = sqlx::query_as::<_, NoteListItem>(&data_sql).bind(&user.user_id);
    for p in &params {
        q = q.bind(p);
    }
    q = q.bind(limit).bind(offset);

    match q.fetch_all(pool.get_ref()).await {
        Ok(data) => {
            HttpResponse::Ok().json(NoteListResponse {
                data,
                total: total.0,
                limit,
                offset,
            })
        }
        Err(e) => {
            log::error!("notes list failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch notes"))
        }
    }
}

async fn list_with_search(
    user: &AuthenticatedUser,
    pool: &web::Data<DbPool>,
    search: &str,
    folder: Option<&str>,
    tag: Option<&str>,
    limit: i64,
    offset: i64,
) -> HttpResponse {
    use crate::apps::llm::providers::embedding;

    // Build a prefix-aware tsquery so "decalitr" matches indexed "decalitro".
    // Each whitespace-separated token is stripped of punctuation, escaped, and
    // suffixed with ":*" (lexeme prefix), then ANDed together. plainto_tsquery
    // only matches whole normalized lexemes, which is why partial queries
    // previously returned zero FTS hits (and empty ts_headline output).
    let tsquery_terms: Vec<String> = search
        .split_whitespace()
        .map(|tok| {
            tok.chars()
                .filter(|c| c.is_alphanumeric() || *c == '_')
                .collect::<String>()
        })
        .filter(|s| !s.is_empty())
        .map(|clean| format!("{}:*", clean.replace('\'', "''")))
        .collect();
    let tsquery = if tsquery_terms.is_empty() {
        // Fall back to plainto_tsquery on empty/punctuation-only input so the
        // query still parses; it'll just match nothing meaningful.
        format!("plainto_tsquery('english', '{}')", search.replace('\'', "''"))
    } else {
        format!("to_tsquery('english', '{}')", tsquery_terms.join(" & "))
    };
    let headline_expr = format!(
        "ts_headline('english', content, {}, 'MaxWords=30, MinWords=15, StartSel=<b>, StopSel=</b>')",
        tsquery
    );

    // ── Build filter clauses ──
    let mut filter_clauses = vec!["n.user_id = $1".to_string()];

    if folder.is_some() {
        filter_clauses.push("n.folder = $2".to_string());
    }
    if tag.is_some() {
        let idx = if folder.is_some() { 3 } else { 2 };
        filter_clauses.push(format!("${} = ANY(n.tags)", idx));
    }
    let filter_sql = filter_clauses.join(" AND ");

    // ── Try to get a query embedding for hybrid search ──
    // Cache the query embedding in moka to avoid repeated API calls
    let query_embedding: Option<Vec<f32>> = {
        static EMBED_CACHE: std::sync::OnceLock<moka::future::Cache<String, Vec<f32>>> =
            std::sync::OnceLock::new();
        let cache = EMBED_CACHE.get_or_init(|| {
            moka::future::Cache::builder()
                .time_to_live(std::time::Duration::from_secs(86_400)) // 24h
                .max_capacity(10_000)
                .build()
        });

        let key = embedding::cache_key(search);
        if let Some(vec) = cache.get(&key).await {
            Some(vec)
        } else {
            match embedding::embed(pool.get_ref(), search, 1536).await {
                Ok(vec) => {
                    cache.insert(key, vec.clone()).await;
                    Some(vec)
                }
                Err(e) => {
                    log::warn!("Embedding fetch failed for search, falling back to FTS-only: {e}");
                    None
                }
            }
        }
    };

    let data: Vec<NoteListItem>;
    let total: i64;

    if let Some(ref emb) = query_embedding {
        // ── Hybrid RRF: FTS + Vector + Trigram ──
        let pg_vec = pgvector::Vector::from(emb.clone());
        let vector_str = format!("[{}]", pg_vec.as_slice().iter()
            .map(|x| x.to_string())
            .collect::<Vec<_>>()
            .join(","));
        let k: f64 = 60.0; // RRF constant

        // Build the RRF SQL: three pools of 100 candidates each, combined and reranked
        let hybrid_sql = format!(
            r#"
            WITH
            fts_pool AS (
                SELECT n.id, n.title, n.tags, n.folder, n.created_at, n.updated_at,
                       ({headline}) AS headline,
                       ts_rank(n.content_tsv, {tsq}) AS score_fts,
                       ROW_NUMBER() OVER (ORDER BY ts_rank(n.content_tsv, {tsq}) DESC) AS rn_fts
                FROM notes n
                WHERE {filter} AND n.content_tsv @@ {tsq}
                ORDER BY score_fts DESC
                LIMIT 100
            ),
            vec_pool AS (
                SELECT n.id, n.title, n.tags, n.folder, n.created_at, n.updated_at,
                       NULL::TEXT AS headline,
                       (1.0 - (n.embedding <=> '{vec}'::vector)) AS score_vec,
                       ROW_NUMBER() OVER (ORDER BY (1.0 - (n.embedding <=> '{vec}'::vector)) DESC) AS rn_vec
                FROM notes n
                WHERE {filter} AND n.embedding IS NOT NULL
                ORDER BY score_vec DESC
                LIMIT 100
            ),
            tri_pool AS (
                SELECT n.id, n.title, n.tags, n.folder, n.created_at, n.updated_at,
                       NULL::TEXT AS headline,
                       similarity(n.title, '{search_esc}') AS score_tri,
                       ROW_NUMBER() OVER (ORDER BY similarity(n.title, '{search_esc}') DESC) AS rn_tri
                FROM notes n
                WHERE {filter} AND n.title % '{search_esc}'
                ORDER BY score_tri DESC
                LIMIT 100
            ),
            combined AS (
                SELECT id, title, tags, folder, created_at, updated_at, headline,
                       COALESCE(1.0 / ({k} + rn_fts), 0.0) AS rrf_fts,
                       0.0 AS rrf_vec, 0.0 AS rrf_tri
                FROM fts_pool
                UNION ALL
                SELECT id, title, tags, folder, created_at, updated_at, headline,
                       0.0 AS rrf_fts,
                       COALESCE(1.0 / ({k} + rn_vec), 0.0) AS rrf_vec,
                       0.0 AS rrf_tri
                FROM vec_pool
                UNION ALL
                SELECT id, title, tags, folder, created_at, updated_at, headline,
                       0.0 AS rrf_fts, 0.0 AS rrf_vec,
                       COALESCE(1.0 / ({k} + rn_tri), 0.0) AS rrf_tri
                FROM tri_pool
            )
            SELECT id, title, tags, folder, created_at, updated_at, headline, rrf_score,
                   COUNT(*) OVER() AS total_hits
            FROM (
                SELECT id, title, tags, folder, created_at, updated_at, MAX(headline) AS headline,
                       (SUM(rrf_fts) + SUM(rrf_vec) + SUM(rrf_tri))::FLOAT8 AS rrf_score
                FROM combined
                GROUP BY id, title, tags, folder, created_at, updated_at
                ORDER BY rrf_score DESC
                LIMIT {limit} OFFSET {offset}
            ) ranked
            "#,
            headline = headline_expr,
            tsq = tsquery,
            vec = vector_str,
            search_esc = search.replace('\'', "''"),
            filter = filter_sql,
            k = k,
            limit = limit,
            offset = offset,
        );

        // Build and run the hybrid data query
        let mut q = sqlx::query_as::<_, (Uuid, String, Vec<String>, Option<String>, Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>, Option<String>, f64, i64)>(&hybrid_sql)
            .bind(&user.user_id);
        if let Some(f) = folder { q = q.bind(f); }
        if let Some(t) = tag { q = q.bind(t); }

        match q.fetch_all(pool.get_ref()).await {
            Ok(rows) => {
                total = rows.first().map(|r| r.8).unwrap_or(0);
                data = rows.into_iter().map(|(id, title, tags, folder, created_at, updated_at, headline, score, _)| {
                    NoteListItem { id, title, tags, folder, created_at, updated_at, headline, score: Some(score) }
                }).collect();
            }
            Err(e) => {
                log::error!("hybrid search failed: {e}");
                return HttpResponse::InternalServerError().json(err("Search failed"));
            }
        }
    } else {
        // ── Fallback: FTS-only (existing behavior) ──
        let mut where_clauses = vec![
            format!("user_id = $1"),
            format!("content_tsv @@ {}", tsquery),
        ];
        let mut idx = 2u32;
        if folder.is_some() { where_clauses.push(format!("folder = ${}", idx)); idx += 1; }
        if tag.is_some() { where_clauses.push(format!("${} = ANY(tags)", idx)); idx += 1; }
        let where_sql = where_clauses.join(" AND ");

        let count_sql = format!("SELECT COUNT(*) FROM notes WHERE {}", where_sql);
        let mut count_q = sqlx::query_as::<_, (i64,)>(&count_sql).bind(&user.user_id);
        if let Some(f) = folder { count_q = count_q.bind(f); }
        if let Some(t) = tag { count_q = count_q.bind(t); }
        total = match count_q.fetch_one(pool.get_ref()).await {
            Ok(c) => c.0,
            Err(e) => {
                log::error!("search count failed: {e}");
                return HttpResponse::InternalServerError().json(err("Search failed"));
            }
        };

        let data_sql = format!(
            "SELECT id, title, tags, folder, created_at, updated_at, ({}) AS headline, \
             (ts_rank(content_tsv, {}))::FLOAT8 AS score \
             FROM notes WHERE {} \
             ORDER BY score DESC, updated_at DESC \
             LIMIT ${} OFFSET ${}",
            headline_expr, tsquery, where_sql, idx, idx + 1
        );

        let mut q = sqlx::query_as::<_, (Uuid, String, Vec<String>, Option<String>, Option<chrono::DateTime<chrono::Utc>>, Option<chrono::DateTime<chrono::Utc>>, Option<String>, f64)>(&data_sql)
            .bind(&user.user_id);
        if let Some(f) = folder { q = q.bind(f); }
        if let Some(t) = tag { q = q.bind(t); }
        q = q.bind(limit).bind(offset);

        match q.fetch_all(pool.get_ref()).await {
            Ok(rows) => {
                data = rows.into_iter().map(|(id, title, tags, folder, created_at, updated_at, headline, score)| {
                    NoteListItem { id, title, tags, folder, created_at, updated_at, headline, score: Some(score) }
                }).collect();
            }
            Err(e) => {
                log::error!("search failed: {e}");
                return HttpResponse::InternalServerError().json(err("Search failed"));
            }
        }
    }

    HttpResponse::Ok().json(NoteListResponse {
        data,
        total,
        limit,
        offset,
    })
}

// ── GET SINGLE NOTE ──────────────────────────────────────────────────────

pub async fn get_note(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }
    let id = path.into_inner();

    let sql = format!("SELECT {} FROM notes WHERE id = $1 AND user_id = $2", NOTE_FIELDS);
    match sqlx::query_as::<_, Note>(&sql)
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(Some(note)) => HttpResponse::Ok().json(note),
        Ok(None) => HttpResponse::NotFound().json(err("Note not found")),
        Err(e) => {
            log::error!("notes get failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch note"))
        }
    }
}

// ── CREATE NOTE ──────────────────────────────────────────────────────────

pub async fn create_note(
    user: AuthenticatedUser,
    body: web::Json<CreateNoteRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }

    if let Some(r) = validate_note(&body.title, &body.content, &body.tags, &body.folder) {
        return r;
    }

    let sql = format!(
        "INSERT INTO notes (user_id, title, content, tags, folder) \
         VALUES ($1, $2, $3, $4, $5) \
         RETURNING {}",
        NOTE_FIELDS
    );

    match sqlx::query_as::<_, Note>(&sql)
        .bind(&user.user_id)
        .bind(&body.title)
        .bind(&body.content)
        .bind(&body.tags)
        .bind(&body.folder)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(note) => {
            // Enqueue embedding generation (non-blocking; fire-and-forget)
            let pool_clone = pool.get_ref().clone();
            let note_id = note.id;
            let content = note.content.clone();
            tokio::spawn(async move {
                if let Err(e) = sqlx::query(
                    "INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)"
                )
                .bind(note_id)
                .bind(content)
                .execute(&pool_clone)
                .await
                {
                    log::error!("Failed to enqueue embedding job for note {note_id}: {e}");
                }
            });
            bus.publish(NoteAction::Created, note.id);
            HttpResponse::Created().json(note)
        }
        Err(e) => {
            log::error!("notes create failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to create note"))
        }
    }
}

// ── UPDATE NOTE ──────────────────────────────────────────────────────────

pub async fn update_note(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    body: web::Json<UpdateNoteRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();

    // Fetch existing
    let existing_sql = format!("SELECT {} FROM notes WHERE id = $1 AND user_id = $2", NOTE_FIELDS);
    let existing: Option<Note> = match sqlx::query_as::<_, Note>(&existing_sql)
        .bind(id)
        .bind(&user.user_id)
        .fetch_optional(pool.get_ref())
        .await
    {
        Ok(v) => v,
        Err(e) => {
            log::error!("notes update lookup failed: {e}");
            return HttpResponse::InternalServerError().json(err("Lookup failed"));
        }
    };

    let existing = match existing {
        Some(e) => e,
        None => return HttpResponse::NotFound().json(err("Note not found")),
    };

    let new_title = body.title.clone().unwrap_or(existing.title);
    let new_content = body.content.clone().unwrap_or(existing.content);
    let new_tags = body.tags.clone().unwrap_or(existing.tags);
    let new_folder = body.folder.clone().or(existing.folder);

    // Validate merged values
    if let Some(r) = validate_note(&new_title, &new_content, &new_tags, new_folder.as_deref().unwrap_or("/")) {
        return r;
    }

    let sql = format!(
        "UPDATE notes SET title = $1, content = $2, tags = $3, folder = $4 \
         WHERE id = $5 AND user_id = $6 \
         RETURNING {}",
        NOTE_FIELDS
    );

    match sqlx::query_as::<_, Note>(&sql)
        .bind(&new_title)
        .bind(&new_content)
        .bind(&new_tags)
        .bind(&new_folder)
        .bind(id)
        .bind(&user.user_id)
        .fetch_one(pool.get_ref())
        .await
    {
        Ok(note) => {
            // Enqueue embedding regeneration (non-blocking; fire-and-forget)
            let pool_clone = pool.get_ref().clone();
            let note_id = note.id;
            let content = note.content.clone();
            tokio::spawn(async move {
                // Delete any pending jobs for this note (avoid duplicates)
                let _ = sqlx::query(
                    "DELETE FROM embedding_jobs WHERE note_id = $1"
                )
                .bind(note_id)
                .execute(&pool_clone)
                .await;
                if let Err(e) = sqlx::query(
                    "INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)"
                )
                .bind(note_id)
                .bind(content)
                .execute(&pool_clone)
                .await
                {
                    log::error!("Failed to enqueue embedding job for note {note_id}: {e}");
                }
            });
            bus.publish(NoteAction::Updated, note.id);
            HttpResponse::Ok().json(note)
        }
        Err(e) => {
            log::error!("notes update failed: {e}");
            HttpResponse::BadRequest().json(err("Failed to update note"))
        }
    }
}

// ── DELETE NOTE ──────────────────────────────────────────────────────────

pub async fn delete_note(
    user: AuthenticatedUser,
    path: web::Path<Uuid>,
    pool: web::Data<DbPool>,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }
    let id = path.into_inner();

    match sqlx::query("DELETE FROM notes WHERE id = $1 AND user_id = $2")
        .bind(id)
        .bind(&user.user_id)
        .execute(pool.get_ref())
        .await
    {
        Ok(res) if res.rows_affected() > 0 => {
            bus.publish(NoteAction::Deleted, id);
            HttpResponse::Ok().json(serde_json::json!({ "deleted": true, "id": id }))
        }
        Ok(_) => HttpResponse::NotFound().json(err("Note not found")),
        Err(e) => {
            log::error!("notes delete failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to delete note"))
        }
    }
}

// ── RENAME FOLDER ─────────────────────────────────────────────────────────
//
// Folders are ephemeral (just the `folder` path on notes), so renaming/moving
// one is a bulk prefix-rewrite over every note at that path and any subfolder.
// e.g. from="/banking", to="/finance" turns "/banking" → "/finance" and
// "/banking/cards" → "/finance/cards".
pub async fn rename_folder(
    user: AuthenticatedUser,
    body: web::Json<RenameFolderRequest>,
    pool: web::Data<DbPool>,
    bus: web::Data<NotesEventBus>,
) -> impl Responder {
    if let Some(r) = require_write(&user) {
        return r;
    }

    let from = body.from.trim().to_string();
    let to = body.to.trim().to_string();

    // Validate both paths look like folders.
    for (label, p) in [("from", &from), ("to", &to)] {
        if p.is_empty() || p == "/" {
            return HttpResponse::BadRequest()
                .json(err(format!("'{label}' must be a non-root folder path")));
        }
        if !p.starts_with('/') {
            return HttpResponse::BadRequest()
                .json(err(format!("'{label}' must start with /")));
        }
        if p.len() > 255 {
            return HttpResponse::BadRequest()
                .json(err(format!("'{label}' must be 255 chars or fewer")));
        }
    }
    if from == to {
        return HttpResponse::BadRequest().json(err("Source and target folders are the same"));
    }
    // Refuse to move a folder into itself (would recurse the prefix).
    if to.starts_with(&format!("{from}/")) {
        return HttpResponse::BadRequest()
            .json(err("Cannot move a folder into one of its own subfolders"));
    }

    // Rewrite the prefix: an exact match becomes `to` (substring past the prefix
    // is empty), a subfolder keeps its tail (e.g. "/x/sub" → "/to/sub").
    let from_like = format!("{from}/%");
    let from_len = from.chars().count() as i32;
    let sql = "UPDATE notes \
         SET folder = $1 || substring(folder FROM $2) \
         WHERE user_id = $3 AND (folder = $4 OR folder LIKE $5) \
         RETURNING id";

    match sqlx::query_as::<_, (Uuid,)>(sql)
        .bind(&to)
        .bind(from_len + 1)
        .bind(&user.user_id)
        .bind(&from)
        .bind(&from_like)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => {
            // Folder is metadata-only, so no embeddings change — just notify
            // listeners that these notes moved.
            for (id,) in &rows {
                bus.publish(NoteAction::Updated, *id);
            }
            HttpResponse::Ok().json(serde_json::json!({
                "from": from,
                "to": to,
                "updated": rows.len(),
            }))
        }
        Err(e) => {
            log::error!("notes folder rename failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to rename folder"))
        }
    }
}

// ── LIST TAGS ─────────────────────────────────────────────────────────────

pub async fn list_tags(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }

    let sql = "SELECT DISTINCT UNNEST(tags) AS tag FROM notes WHERE user_id = $1 ORDER BY tag";
    match sqlx::query_as::<_, (String,)>(sql)
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => {
            let tags: Vec<String> = rows.into_iter().map(|(t,)| t).collect();
            HttpResponse::Ok().json(tags)
        }
        Err(e) => {
            log::error!("notes tags failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch tags"))
        }
    }
}

// ── LIST FOLDERS ──────────────────────────────────────────────────────────

pub async fn list_folders(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(r) = require_read(&user) {
        return r;
    }

    let sql = "SELECT DISTINCT folder FROM notes WHERE user_id = $1 AND folder IS NOT NULL ORDER BY folder";
    match sqlx::query_as::<_, (String,)>(sql)
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(rows) => {
            let folders: Vec<String> = rows.into_iter().map(|(f,)| f).collect();
            HttpResponse::Ok().json(folders)
        }
        Err(e) => {
            log::error!("notes folders failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to fetch folders"))
        }
    }
}

// ── SEARCH FOLDERS ────────────────────────────────────────────────────────

pub async fn search_folders(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<super::models::FolderSearchQuery>,
) -> impl Responder {
    use super::models::FolderMatch;
    use std::collections::HashMap;

    if let Some(r) = require_read(&user) {
        return r;
    }

    let needle = query.q.as_deref().unwrap_or("").trim().to_lowercase();
    let limit = query.limit.unwrap_or(20).clamp(1, 100) as usize;

    if needle.is_empty() {
        return HttpResponse::Ok().json(Vec::<FolderMatch>::new());
    }

    // Collect distinct folders with their direct file counts. We expand to
    // every ancestor path in Rust so that a folder like "/projects" surfaces
    // even when only "/projects/example/acp/plan" exists in notes.folder.
    let sql = "SELECT folder, COUNT(*)::BIGINT FROM notes \
               WHERE user_id = $1 AND folder IS NOT NULL AND folder <> '' \
               GROUP BY folder";
    let rows: Vec<(String, i64)> = match sqlx::query_as(sql)
        .bind(&user.user_id)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(r) => r,
        Err(e) => {
            log::error!("folder search load failed: {e}");
            return HttpResponse::InternalServerError().json(err("Folder search failed"));
        }
    };

    let mut counts: HashMap<String, i64> = HashMap::new();
    for (folder, count) in rows {
        if folder == "/" {
            continue;
        }
        let mut cur = String::new();
        for seg in folder.split('/').filter(|s| !s.is_empty()) {
            cur.push('/');
            cur.push_str(seg);
            *counts.entry(cur.clone()).or_insert(0) += count;
        }
    }

    // Score: prefer leaf prefix > leaf substring > path substring; tiebreak by
    // shallower depth then alphabetical so parents sit above their children.
    let mut scored: Vec<(f64, FolderMatch)> = counts
        .into_iter()
        .filter_map(|(path, file_count)| {
            let leaf = path.rsplit('/').next().unwrap_or("").to_string();
            let leaf_lc = leaf.to_lowercase();
            let path_lc = path.to_lowercase();
            let leaf_hit = leaf_lc.contains(&needle);
            let path_hit = path_lc.contains(&needle);
            if !leaf_hit && !path_hit {
                return None;
            }
            let mut score = 0.0_f64;
            if leaf_lc == needle {
                score += 4.0;
            } else if leaf_lc.starts_with(&needle) {
                score += 3.0;
            } else if leaf_hit {
                score += 2.0;
            }
            if path_hit {
                score += 0.5;
            }
            score -= (path.matches('/').count() as f64) * 0.05;
            Some((score, FolderMatch { path, leaf, file_count }))
        })
        .collect();

    scored.sort_by(|a, b| {
        b.0.partial_cmp(&a.0)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.1.path.cmp(&b.1.path))
    });

    let out: Vec<FolderMatch> = scored.into_iter().take(limit).map(|(_, m)| m).collect();
    HttpResponse::Ok().json(out)
}

// ── BROWSE FOLDER ─────────────────────────────────────────────────────────

pub async fn browse_folder(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    query: web::Query<super::models::BrowseQuery>,
) -> impl Responder {
    use super::models::{BrowseResponse, NoteListItem};

    if let Some(r) = require_read(&user) {
        return r;
    }

    let path = query.path.as_deref().unwrap_or("/");

    // Validate path
    if !path.starts_with('/') {
        return HttpResponse::BadRequest().json(err("Path must start with /"));
    }

    // ── Files directly in this folder ──
    let files_sql = "SELECT id, title, tags, folder, created_at, updated_at \
                     FROM notes WHERE user_id = $1 AND folder = $2 \
                     ORDER BY updated_at DESC";

    let files: Vec<NoteListItem> = match sqlx::query_as::<_, NoteListItem>(files_sql)
        .bind(&user.user_id)
        .bind(path)
        .fetch_all(pool.get_ref())
        .await
    {
        Ok(f) => f,
        Err(e) => {
            log::error!("notes browse files failed: {e}");
            return HttpResponse::InternalServerError().json(err("Browse failed"));
        }
    };

    // ── Direct subfolders (one level deep) ──
    // Build the SQL safely — the path is validated to start with '/'
    // and we escape single quotes for the regex/pattern, then use bind for the full condition.
    let subfolder_sql = if path == "/" {
        "SELECT DISTINCT SUBSTRING(folder FROM '^/([^/]+)') AS name \
         FROM notes WHERE user_id = $1 AND folder LIKE '/%' AND folder != '/'"
            .to_string()
    } else {
        format!(
            "SELECT DISTINCT SUBSTRING(folder FROM '^{}/?([^/]+)') AS name \
             FROM notes WHERE user_id = $1 AND folder LIKE $2 AND folder != $3",
            path.replace('\'', "''"),
        )
    };

    let like_pattern = if path == "/" {
        String::new()
    } else {
        format!("{}%", path)
    };

    let mut subfolder_query = sqlx::query_as::<_, (String,)>(&subfolder_sql)
        .bind(&user.user_id);

    if path != "/" {
        subfolder_query = subfolder_query
            .bind(&like_pattern)
            .bind(path);
    }

    let subfolders: Vec<String> = match subfolder_query.fetch_all(pool.get_ref()).await
    {
        Ok(rows) => rows.into_iter().map(|(s,)| s).collect(),
        Err(e) => {
            log::error!("notes browse subfolders failed: {e}");
            return HttpResponse::InternalServerError().json(err("Browse failed"));
        }
    };

    HttpResponse::Ok().json(BrowseResponse {
        path: path.to_string(),
        files,
        subfolders,
    })
}

pub async fn empty_trash(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
) -> impl Responder {
    if let Some(resp) = require_write(&user) {
        return resp;
    }

    let result = sqlx::query(
        r#"
        DELETE FROM notes 
        WHERE user_id = $1 
          AND folder = '/.trash' 
          AND updated_at < NOW() - INTERVAL '7 days'
        "#
    )
    .bind(user.user_id)
    .execute(pool.get_ref())
    .await;

    match result {
        Ok(res) => HttpResponse::Ok().json(serde_json::json!({
            "message": "Trash emptied successfully",
            "deleted_count": res.rows_affected()
        })),
        Err(e) => {
            log::error!("empty trash failed: {e}");
            HttpResponse::InternalServerError().json(err("Failed to empty trash"))
        }
    }
}

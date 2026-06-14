use actix_web::{web, HttpResponse, Responder};
use aws_sdk_s3::primitives::ByteStream;
use futures_util::TryStreamExt;
use sqlx::postgres::PgPoolCopyExt;

use super::models::{
    ApiMessage, CreateDumpResponse, DownloadResponse, DumpInfo, KeyRequest, ListResponse,
    RestoreResponse,
};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::storage::handlers::{download_url, s3_client};
use crate::db::db::DbPool;

// All DB backups live under this single S3 prefix.
const DUMP_PREFIX: &str = "dump/";
const REQUIRED_PERM: &str = "admin_access";

fn forbidden() -> HttpResponse {
    HttpResponse::Forbidden().json(ApiMessage {
        message: "admin_access required".to_string(),
    })
}

fn err(status: actix_web::http::StatusCode, msg: impl Into<String>) -> HttpResponse {
    HttpResponse::build(status).json(ApiMessage { message: msg.into() })
}

fn bad(msg: impl Into<String>) -> HttpResponse {
    err(actix_web::http::StatusCode::BAD_REQUEST, msg)
}

fn server_err(msg: impl Into<String>) -> HttpResponse {
    err(actix_web::http::StatusCode::INTERNAL_SERVER_ERROR, msg)
}

// Rejects keys that don't live under `dump/` so these actions can never touch
// arbitrary objects in the bucket. Also blocks path traversal in the suffix.
fn validate_dump_key(key: &str) -> Result<(), HttpResponse> {
    if !key.starts_with(DUMP_PREFIX) || key.ends_with('/') || key.contains("..") {
        return Err(bad("invalid dump key"));
    }
    Ok(())
}

fn filename_of(key: &str) -> String {
    key.rsplit('/').next().unwrap_or(key).to_string()
}

// ── Dump building ───────────────────────────────────────────────────────────

// Produces a self-contained plain-text dump of every table in the `public`
// schema using Postgres COPY (text format). The format is psql-restorable AND
// machine-parseable by `restore_dump`: a `COPY "t" (cols) FROM stdin;` line,
// the raw COPY rows, then a `\.` terminator. COPY's text format is type-faithful
// (handles pgvector, bytea, nulls) without any external tools like pg_dump.
//
// Returns (bytes, table_count, total_rows).
async fn build_dump(pool: &DbPool) -> Result<(Vec<u8>, usize, i64), String> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename",
    )
    .fetch_all(pool)
    .await
    .map_err(|e| format!("list tables: {e}"))?;

    let mut out: Vec<u8> = Vec::new();
    let created = chrono::Utc::now().to_rfc3339();
    out.extend_from_slice(
        format!(
            "-- Piuma Vault DB dump v1\n-- created_at: {created}\n-- tables: {}\n\n",
            tables.len()
        )
        .as_bytes(),
    );

    // A header line listing every table so a human (or psql) can truncate up
    // front. The restore parser derives the truncate set from the COPY blocks,
    // so this line is informational only.
    if !tables.is_empty() {
        let quoted = tables
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(", ");
        out.extend_from_slice(
            format!("-- TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE;\n\n").as_bytes(),
        );
    }

    let mut total_rows: i64 = 0;
    let mut table_count = 0usize;

    for table in &tables {
        // Skip generated columns: COPY TO would emit them but COPY FROM rejects
        // them, so excluding keeps dump and restore symmetric.
        let cols: Vec<String> = sqlx::query_scalar(
            "SELECT column_name FROM information_schema.columns \
             WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' \
             ORDER BY ordinal_position",
        )
        .bind(table)
        .fetch_all(pool)
        .await
        .map_err(|e| format!("columns for {table}: {e}"))?;

        if cols.is_empty() {
            continue;
        }

        let collist = cols
            .iter()
            .map(|c| format!("\"{c}\""))
            .collect::<Vec<_>>()
            .join(", ");

        out.extend_from_slice(format!("COPY \"{table}\" ({collist}) FROM stdin;\n").as_bytes());

        let mut stream = pool
            .copy_out_raw(&format!("COPY \"{table}\" ({collist}) TO STDOUT"))
            .await
            .map_err(|e| format!("copy out {table}: {e}"))?;

        let mut rows: i64 = 0;
        while let Some(chunk) = stream
            .try_next()
            .await
            .map_err(|e| format!("read {table}: {e}"))?
        {
            rows += chunk.iter().filter(|b| **b == b'\n').count() as i64;
            out.extend_from_slice(&chunk);
        }

        out.extend_from_slice(b"\\.\n\n");
        total_rows += rows;
        table_count += 1;
    }

    Ok((out, table_count, total_rows))
}

// ── Dump + upload (reusable) ────────────────────────────────────────────────

/// Build a full DB dump and upload it to the S3 `dump/` prefix. Self-contained
/// (only needs the pool) so both the HTTP handler and the agent's
/// `backup_database` tool can drive a backup. Errors are returned as strings.
pub async fn run_dump(pool: &DbPool) -> Result<CreateDumpResponse, String> {
    let (client, bucket) = s3_client(pool)
        .await
        .map_err(|e| format!("S3 not configured: {e}"))?;

    let (data, tables, rows) = build_dump(pool)
        .await
        .map_err(|e| format!("dump failed: {e}"))?;

    let now = chrono::Utc::now();
    let filename = format!("piuma-vault_{}.sql", now.format("%Y%m%d_%H%M%S"));
    let key = format!("{DUMP_PREFIX}{filename}");
    let size = data.len() as i64;

    client
        .put_object()
        .bucket(&bucket)
        .key(&key)
        .body(ByteStream::from(data))
        .content_type("application/sql")
        .send()
        .await
        .map_err(|e| format!("upload failed: {e}"))?;

    Ok(CreateDumpResponse {
        key,
        filename,
        size,
        created_at: now.to_rfc3339(),
        tables,
        rows,
    })
}

// ── Handlers ──────────────────────────────────────────────────────────────

/// POST /admin/db-dump/create — dump the whole DB and upload it to `dump/`.
pub async fn create_dump(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    match run_dump(pool.get_ref()).await {
        Ok(resp) => HttpResponse::Ok().json(resp),
        Err(e) => server_err(e),
    }
}

/// GET /admin/db-dump/list — list backups under `dump/`, newest first.
pub async fn list_dumps(user: AuthenticatedUser, pool: web::Data<DbPool>) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return server_err(format!("S3 not configured: {e}")),
    };

    let out = match client
        .list_objects_v2()
        .bucket(&bucket)
        .prefix(DUMP_PREFIX)
        .send()
        .await
    {
        Ok(o) => o,
        Err(e) => return server_err(format!("list failed: {e}")),
    };

    let mut dumps: Vec<DumpInfo> = Vec::new();
    for o in out.contents() {
        let key = o.key().unwrap_or("").to_string();
        // Skip the folder marker itself and any zero-byte directory placeholders.
        if key.is_empty() || key.ends_with('/') {
            continue;
        }
        let last_modified = o
            .last_modified()
            .and_then(|d| chrono::DateTime::from_timestamp(d.secs(), 0))
            .map(|d| d.to_rfc3339());
        dumps.push(DumpInfo {
            filename: filename_of(&key),
            key,
            size: o.size().unwrap_or(0),
            last_modified,
        });
    }
    // Filenames are timestamped, so a reverse key sort yields newest-first.
    dumps.sort_by(|a, b| b.key.cmp(&a.key));

    HttpResponse::Ok().json(ListResponse { dumps })
}

/// POST /admin/db-dump/download — time-limited download URL for one backup.
pub async fn download_dump(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<KeyRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    if let Err(resp) = validate_dump_key(&body.key) {
        return resp;
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return server_err(format!("S3 not configured: {e}")),
    };

    match download_url(pool.get_ref(), &client, &bucket, &body.key, 900).await {
        Ok((url, expires_at)) => HttpResponse::Ok().json(DownloadResponse {
            url,
            expires_at,
            filename: filename_of(&body.key),
        }),
        Err(e) => server_err(format!("could not sign url: {e}")),
    }
}

/// POST /admin/db-dump/delete — remove one backup from `dump/`.
pub async fn delete_dump(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<KeyRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    if let Err(resp) = validate_dump_key(&body.key) {
        return resp;
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return server_err(format!("S3 not configured: {e}")),
    };

    match client
        .delete_object()
        .bucket(&bucket)
        .key(&body.key)
        .send()
        .await
    {
        Ok(_) => HttpResponse::Ok().json(ApiMessage {
            message: format!("Deleted {}", filename_of(&body.key)),
        }),
        Err(e) => server_err(format!("delete failed: {e}")),
    }
}

/// POST /admin/db-dump/restore — DESTRUCTIVE: wipe every table this dump covers
/// and reload it from the backup. Runs in one transaction with FK triggers
/// disabled so table order doesn't matter; rolls back on any failure.
pub async fn restore_dump(
    user: AuthenticatedUser,
    pool: web::Data<DbPool>,
    body: web::Json<KeyRequest>,
) -> impl Responder {
    if !check_permission(&user, REQUIRED_PERM) {
        return forbidden();
    }
    if let Err(resp) = validate_dump_key(&body.key) {
        return resp;
    }
    let (client, bucket) = match s3_client(pool.get_ref()).await {
        Ok(v) => v,
        Err(e) => return server_err(format!("S3 not configured: {e}")),
    };

    // Fetch the dump file into memory.
    let obj = match client
        .get_object()
        .bucket(&bucket)
        .key(&body.key)
        .send()
        .await
    {
        Ok(o) => o,
        Err(e) => return server_err(format!("fetch dump failed: {e}")),
    };
    let bytes = match obj.body.collect().await {
        Ok(b) => b.into_bytes(),
        Err(e) => return server_err(format!("read dump body failed: {e}")),
    };
    let text = match String::from_utf8(bytes.to_vec()) {
        Ok(t) => t,
        Err(_) => return server_err("dump is not valid UTF-8"),
    };

    let (blocks, tables) = parse_dump(&text);
    if blocks.is_empty() {
        return bad("dump contains no COPY data");
    }

    match apply_restore(pool.get_ref(), &blocks, &tables).await {
        Ok(rows) => HttpResponse::Ok().json(RestoreResponse {
            restored: true,
            tables: blocks.len(),
            rows,
        }),
        Err(e) => server_err(format!("restore failed (rolled back): {e}")),
    }
}

// Parses a v1 dump into COPY blocks. Returns ((copy_command, data) pairs,
// distinct table names). A line starting with `COPY ` and containing `from
// stdin` opens a block; everything up to a lone `\.` is that block's data.
// COPY's text format escapes any in-field `\.`, so the terminator is unambiguous.
fn parse_dump(text: &str) -> (Vec<(String, String)>, Vec<String>) {
    let mut blocks: Vec<(String, String)> = Vec::new();
    let mut tables: Vec<String> = Vec::new();
    let mut cur_cmd: Option<String> = None;
    let mut cur_data: Vec<&str> = Vec::new();

    for raw in text.split('\n') {
        let line = raw.trim_end_matches('\r');
        if cur_cmd.is_some() {
            if line == "\\." {
                let cmd = cur_cmd.take().unwrap();
                let data = if cur_data.is_empty() {
                    String::new()
                } else {
                    format!("{}\n", cur_data.join("\n"))
                };
                blocks.push((cmd, data));
                cur_data.clear();
            } else {
                cur_data.push(line);
            }
        } else if line.starts_with("COPY ") && line.to_lowercase().contains("from stdin") {
            // copy_in_raw wants the statement without the trailing semicolon.
            let cmd = line.trim_end().trim_end_matches(';').to_string();
            if let Some(rest) = line.strip_prefix("COPY \"") {
                if let Some(end) = rest.find('"') {
                    tables.push(rest[..end].to_string());
                }
            }
            cur_cmd = Some(cmd);
        }
    }
    (blocks, tables)
}

// Applies the parsed dump in a single transaction. FK enforcement is disabled
// (session_replication_role = replica) so the COPY order is irrelevant, then
// every covered table is truncated and reloaded. Any error rolls everything back.
async fn apply_restore(
    pool: &DbPool,
    blocks: &[(String, String)],
    tables: &[String],
) -> Result<i64, String> {
    let mut conn = pool.acquire().await.map_err(|e| e.to_string())?;

    sqlx::query("BEGIN")
        .execute(&mut *conn)
        .await
        .map_err(|e| e.to_string())?;

    let result = restore_inner(&mut conn, blocks, tables).await;

    match result {
        Ok(rows) => {
            sqlx::query("COMMIT")
                .execute(&mut *conn)
                .await
                .map_err(|e| e.to_string())?;
            Ok(rows)
        }
        Err(e) => {
            let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
            Err(e)
        }
    }
}

async fn restore_inner(
    conn: &mut sqlx::PgConnection,
    blocks: &[(String, String)],
    tables: &[String],
) -> Result<i64, String> {
    sqlx::query("SET session_replication_role = replica")
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("disable triggers: {e}"))?;

    if !tables.is_empty() {
        let quoted = tables
            .iter()
            .map(|t| format!("\"{t}\""))
            .collect::<Vec<_>>()
            .join(", ");
        sqlx::query(&format!(
            "TRUNCATE TABLE {quoted} RESTART IDENTITY CASCADE"
        ))
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("truncate: {e}"))?;
    }

    let mut total: i64 = 0;
    for (cmd, data) in blocks {
        let mut sink = conn
            .copy_in_raw(cmd)
            .await
            .map_err(|e| format!("copy in start: {e}"))?;
        if !data.is_empty() {
            sink.send(data.as_bytes())
                .await
                .map_err(|e| format!("copy in send: {e}"))?;
        }
        let rows = sink.finish().await.map_err(|e| format!("copy in finish: {e}"))?;
        total += rows as i64;
    }

    sqlx::query("SET session_replication_role = DEFAULT")
        .execute(&mut *conn)
        .await
        .map_err(|e| format!("re-enable triggers: {e}"))?;

    Ok(total)
}

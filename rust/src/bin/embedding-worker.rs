/// Embedding Worker — polls `embedding_jobs` via `FOR UPDATE SKIP LOCKED`,
/// calls Azure OpenAI to generate 1536-dim embeddings, stores them in the
/// notes table, and removes completed jobs. Also handles periodic cleanup:
/// expired pending memory entries and cross-conversation pattern detection.
use std::time::{Duration, Instant};
use tokio::time::sleep;

use backend::apps;

#[tokio::main]
async fn main() {
    env_logger::init();

    log::info!("🧠 Embedding Worker starting...");

    let pool = match backend::db::db::create_pool().await {
        Ok(p) => {
            log::info!("✅ Database connection pool established");
            p
        }
        Err(e) => {
            log::error!("❌ Failed to connect to database: {e}");
            std::process::exit(1);
        }
    };

    // Main loop: poll for pending jobs
    let poll_interval = Duration::from_secs(2);
    let max_attempts = 3;
    let mut last_cleanup = Instant::now();
    let cleanup_interval = Duration::from_secs(600); // every 10 minutes
    let mut last_cross_conv = Instant::now();
    let cross_conv_interval = Duration::from_secs(3600); // every hour

    loop {
        // Periodic: reject expired pending memory entries.
        if last_cleanup.elapsed() >= cleanup_interval {
            match sqlx::query(
                "UPDATE db_memory_entries \
                 SET status = 'rejected', is_active = FALSE, updated_at = NOW() \
                 WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at < NOW() \
                   AND is_active",
            )
            .execute(&pool)
            .await
            {
                Ok(r) => {
                    if r.rows_affected() > 0 {
                        log::info!("🧹 Cleanup: rejected {} expired pending memory entries", r.rows_affected());
                    }
                }
                Err(e) => log::error!("Cleanup query failed: {e}"),
            }
            last_cleanup = Instant::now();
        }

        // Periodic: cross-conversation pattern detection.
        if last_cross_conv.elapsed() >= cross_conv_interval {
            cross_conversation_patterns(&pool).await;
            last_cross_conv = Instant::now();
        }

        // Claim up to 5 jobs at a time with FOR UPDATE SKIP LOCKED
        let jobs: Vec<(uuid::Uuid, uuid::Uuid, String, i32)> = match sqlx::query_as(
            r#"
            DELETE FROM embedding_jobs
            WHERE id IN (
                SELECT id FROM embedding_jobs
                WHERE attempts < $1
                ORDER BY created_at
                LIMIT 5
                FOR UPDATE SKIP LOCKED
            )
            RETURNING id, note_id, content, attempts
            "#,
        )
        .bind(max_attempts)
        .fetch_all(&pool)
        .await
        {
            Ok(rows) => rows,
            Err(e) => {
                log::error!("Failed to poll jobs: {e}");
                sleep(poll_interval).await;
                continue;
            }
        };

        let memory_jobs = drain_memory_jobs(&pool, max_attempts).await;

        if jobs.is_empty() && memory_jobs.is_empty() {
            sleep(poll_interval).await;
            continue;
        }

        if !jobs.is_empty() {
            log::info!("Found {} embedding job(s)", jobs.len());
        }

        for (_job_id, note_id, content, attempts) in jobs {
            log::info!("Embedding note {note_id} (attempt {}/{})", attempts + 1, max_attempts);

            match apps::embeddings::embed(&pool, &content, 1536, "embedding:notes").await {
                Ok(embedding) => {
                    let pg_vec = pgvector::Vector::from(embedding);
                    match sqlx::query(
                        "UPDATE notes SET embedding = $1 WHERE id = $2 AND embedding IS NULL AND deleted_at IS NULL",
                    )
                    .bind(&pg_vec)
                    .bind(note_id)
                    .execute(&pool)
                    .await
                    {
                        Ok(_) => {
                            log::info!("✅ Embedded note {note_id} ({} dims)", pg_vec.as_slice().len());
                        }
                        Err(e) => {
                            log::error!("Failed to store embedding for note {note_id}: {e}");
                            // Re-queue on DB error
                            let _ = sqlx::query(
                                "INSERT INTO embedding_jobs (note_id, content) VALUES ($1, $2)",
                            )
                            .bind(note_id)
                            .bind(&content)
                            .execute(&pool)
                            .await;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Embedding API failed for note {note_id}: {e}");
                    // Re-queue with incremented attempts
                    if attempts + 1 < max_attempts {
                        let _ = sqlx::query(
                            "INSERT INTO embedding_jobs (note_id, content, attempts) VALUES ($1, $2, $3)",
                        )
                        .bind(note_id)
                        .bind(&content)
                        .bind(attempts + 1)
                        .execute(&pool)
                        .await;
                    } else {
                        log::warn!("Note {note_id} exhausted {} embedding attempts, dropped", max_attempts);
                    }
                }
            }

            // Brief pause between embeddings to respect API rate limits
            sleep(Duration::from_millis(200)).await;
        }

        if !memory_jobs.is_empty() {
            log::info!("Found {} memory embedding job(s)", memory_jobs.len());
        }
        for (entry_id, content, attempts) in memory_jobs {
            log::info!("Embedding memory {entry_id} (attempt {}/{})", attempts + 1, max_attempts);
            match apps::embeddings::embed(&pool, &content, 1536, "embedding:memory").await {
                Ok(embedding) => {
                    let pg_vec = pgvector::Vector::from(embedding);
                    match sqlx::query(
                        "UPDATE db_memory_entries SET embedding = $1, updated_at = NOW() WHERE id = $2 AND is_active",
                    )
                    .bind(&pg_vec)
                    .bind(entry_id)
                    .execute(&pool)
                    .await
                    {
                        Ok(_) => log::info!("✅ Embedded memory {entry_id}"),
                        Err(e) => {
                            log::error!("Failed to store embedding for memory {entry_id}: {e}");
                            let _ = sqlx::query(
                                "INSERT INTO db_memory_embedding_jobs (memory_entry_id, content) VALUES ($1, $2)",
                            )
                            .bind(entry_id)
                            .bind(&content)
                            .execute(&pool)
                            .await;
                        }
                    }
                }
                Err(e) => {
                    log::error!("Embedding API failed for memory {entry_id}: {e}");
                    if attempts + 1 < max_attempts {
                        let _ = sqlx::query(
                            "INSERT INTO db_memory_embedding_jobs (memory_entry_id, content, attempts) VALUES ($1, $2, $3)",
                        )
                        .bind(entry_id)
                        .bind(&content)
                        .bind(attempts + 1)
                        .execute(&pool)
                        .await;
                    } else {
                        log::warn!("Memory {entry_id} exhausted {} embedding attempts, dropped", max_attempts);
                    }
                }
            }
            sleep(Duration::from_millis(200)).await;
        }
    }
}

/// Claim up to 5 pending memory embedding jobs (FOR UPDATE SKIP LOCKED), mirroring
/// the notes `embedding_jobs` drain. Returns `(memory_entry_id, content, attempts)`.
async fn drain_memory_jobs(
    pool: &backend::db::db::DbPool,
    max_attempts: i32,
) -> Vec<(uuid::Uuid, String, i32)> {
    sqlx::query_as(
        r#"
        DELETE FROM db_memory_embedding_jobs
        WHERE id IN (
            SELECT id FROM db_memory_embedding_jobs
            WHERE attempts < $1
            ORDER BY created_at
            LIMIT 5
            FOR UPDATE SKIP LOCKED
        )
        RETURNING memory_entry_id, content, attempts
        "#,
    )
    .bind(max_attempts)
    .fetch_all(pool)
    .await
    .unwrap_or_else(|e| {
        log::error!("Failed to poll memory jobs: {e}");
        Vec::new()
    })
}

/// Hourly cross-conversation pattern detection: counts dialectic-derived facts
/// that share the same category, grouped by agent. A future iteration will
/// cluster by embedding distance for true pattern mining.
async fn cross_conversation_patterns(pool: &backend::db::db::DbPool) {
    #[derive(sqlx::FromRow)]
    struct CategoryCount {
        agent: String,
        category: Option<String>,
        cnt: Option<i64>,
    }
    let rows: Vec<CategoryCount> = match sqlx::query_as(
        "SELECT agent, category, COUNT(*) AS cnt \
         FROM db_memory_entries \
         WHERE source = 'dialectic_derived' AND status = 'confirmed' AND is_active \
         GROUP BY agent, category \
         ORDER BY cnt DESC LIMIT 20",
    )
    .fetch_all(pool)
    .await
    {
        Ok(r) => r,
        Err(e) => {
            log::error!("Cross-conversation patterns query failed: {e}");
            return;
        }
    };
    if rows.is_empty() {
        return;
    }
    log::info!(
        "🔍 Cross-conversation: top dialectic-derived categories by agent: {}",
        rows.iter()
            .map(|r| format!("{}/{:?}={}", r.agent, r.category, r.cnt.unwrap_or(0)))
            .collect::<Vec<_>>()
            .join(", ")
    );
}

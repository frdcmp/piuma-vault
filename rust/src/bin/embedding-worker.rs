/// Embedding Worker — polls `embedding_jobs` via `FOR UPDATE SKIP LOCKED`,
/// calls Azure OpenAI to generate 1536-dim embeddings, stores them in the
/// notes table, and removes completed jobs.
use std::time::Duration;
use tokio::time::sleep;

use backend::db;
use backend::apps;

#[tokio::main]
async fn main() {
    env_logger::init();

    log::info!("🧠 Embedding Worker starting...");

    let pool = match db::db::create_pool().await {
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

    loop {
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

        if jobs.is_empty() {
            sleep(poll_interval).await;
            continue;
        }

        log::info!("Found {} embedding job(s)", jobs.len());

        for (_job_id, note_id, content, attempts) in jobs {
            log::info!("Embedding note {note_id} (attempt {}/{})", attempts + 1, max_attempts);

            match apps::llm::providers::embedding::embed(&pool, &content, 1536).await {
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
    }
}

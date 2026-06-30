//! Cron Worker — fires due scheduled agent jobs. Polls `db_cron_jobs.next_run_at`
//! with `FOR UPDATE SKIP LOCKED` (same claim pattern as the notification worker),
//! advances the schedule BEFORE running so a crash can't replay a slot, then
//! executes the job as a headless agent turn (`agents::runner::run_turn`) into a
//! per-job conversation and notifies the owner on completion.

use std::time::Duration;

use backend::apps::agents::registry;
use backend::apps::agents::runner::{run_turn, RunOptions};
use backend::apps::cron::models::{compute_next_run, CronJobRow};
use backend::apps::notifications::{notify, Channels, NewNotification};
use backend::db;
use backend::db::db::DbPool;
use chrono::Utc;
use serde_json::json;
use tokio::time::{sleep, timeout};
use uuid::Uuid;

// A headless run holds the providers' SSE sender (`actix_web::Error`, which is
// not `Send`) across awaits, so its future isn't `Send` and can't go through
// `tokio::spawn`. Run on a current-thread runtime + `spawn_local` instead:
// cooperative concurrency is plenty since every run is I/O-bound (LLM/network).
fn main() {
    env_logger::init();
    log::info!("⏰ Cron Worker starting...");

    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("build current-thread runtime");
    let local = tokio::task::LocalSet::new();

    local.block_on(&rt, async {
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

        let poll_interval = Duration::from_secs(30);
        loop {
            let claimed = claim_due(&pool).await;
            if !claimed.is_empty() {
                log::info!("Firing {} due cron job(s)", claimed.len());
            }
            for job in claimed {
                let pool = pool.clone();
                // Detached: a run can outlive the poll tick (up to max_runtime).
                tokio::task::spawn_local(async move { run_job(pool, job).await });
            }
            sleep(poll_interval).await;
        }
    });
}

/// Atomically claim due jobs and advance their schedule inside one short
/// transaction (no LLM work here), so the row's `next_run_at` already points at
/// the next slot before we run — a crash mid-run won't re-fire immediately.
async fn claim_due(pool: &DbPool) -> Vec<CronJobRow> {
    let mut tx = match pool.begin().await {
        Ok(t) => t,
        Err(e) => {
            log::error!("cron: begin tx failed: {e}");
            return Vec::new();
        }
    };

    let due: Vec<CronJobRow> = match sqlx::query_as(
        "SELECT * FROM db_cron_jobs \
         WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= NOW() \
         ORDER BY next_run_at LIMIT 10 FOR UPDATE SKIP LOCKED",
    )
    .fetch_all(&mut *tx)
    .await
    {
        Ok(rows) => rows,
        Err(e) => {
            log::error!("cron: claim query failed: {e}");
            return Vec::new();
        }
    };

    let now = Utc::now();
    for job in &due {
        let next = compute_next_run(
            &job.schedule_kind,
            job.rrule.as_deref(),
            job.dtstart,
            job.run_at,
            now,
        );
        // Recurring keeps running while it has a next slot; one-shots (and
        // exhausted rules) disable after firing.
        let still_enabled = job.schedule_kind == "recurring" && next.is_some();
        if let Err(e) = sqlx::query(
            "UPDATE db_cron_jobs SET last_run_at = NOW(), next_run_at = $2, enabled = $3 WHERE id = $1",
        )
        .bind(job.id)
        .bind(next)
        .bind(still_enabled)
        .execute(&mut *tx)
        .await
        {
            log::error!("cron: advance job {} failed: {e}", job.id);
        }
    }

    if let Err(e) = tx.commit().await {
        log::error!("cron: commit failed: {e}");
        return Vec::new();
    }
    due
}

/// Ensure the job has a conversation to post into (created lazily on first run),
/// returning its id.
async fn ensure_conversation(pool: &DbPool, job: &CronJobRow) -> Option<Uuid> {
    if let Some(c) = job.conversation_id {
        return Some(c);
    }
    let persona = registry::get(&job.agent).map(|d| d.persona).unwrap_or("piuma");
    let title = format!("⏰ {}", job.title);
    let conv_id: Option<Uuid> = sqlx::query_scalar(
        "INSERT INTO db_chat_conversations (agent, title, identity) VALUES ($1, $2, $3) RETURNING id",
    )
    .bind(&job.agent)
    .bind(&title)
    .bind(persona)
    .fetch_one(pool)
    .await
    .ok();
    if let Some(c) = conv_id {
        let _ = sqlx::query("UPDATE db_cron_jobs SET conversation_id = $2 WHERE id = $1")
            .bind(job.id)
            .bind(c)
            .execute(pool)
            .await;
    }
    conv_id
}

async fn run_job(pool: DbPool, job: CronJobRow) {
    let Some(conv_id) = ensure_conversation(&pool, &job).await else {
        log::error!("cron: couldn't create conversation for job {}", job.id);
        return;
    };

    let run_id: Option<Uuid> =
        sqlx::query_scalar("INSERT INTO db_cron_runs (job_id, status) VALUES ($1, 'running') RETURNING id")
            .bind(job.id)
            .fetch_one(&pool)
            .await
            .ok();
    let Some(run_id) = run_id else {
        log::error!("cron: couldn't insert run row for job {}", job.id);
        return;
    };

    let opts = RunOptions {
        timezone: job.timezone.clone(),
        allow_destructive: job.allow_destructive,
        source: "cron".to_string(),
        // Each scheduled run is independent — run with a clean context instead of
        // replaying (and paying for) the whole reused per-job conversation.
        fresh_context: true,
    };
    let fut = run_turn(&pool, conv_id, &job.user_id, &job.prompt, opts);

    match timeout(Duration::from_secs(job.max_runtime_secs.max(1) as u64), fut).await {
        Ok(Ok(res)) => {
            let summary: String = res.assistant_text.chars().take(280).collect();
            let tools = serde_json::to_value(&res.tools_used).unwrap_or_else(|_| json!([]));
            let _ = sqlx::query(
                "UPDATE db_cron_runs SET status='success', finished_at=NOW(), summary=$2, \
                    message_id=$3, tools_used=$4, tokens_in=$5, tokens_out=$6 WHERE id=$1",
            )
            .bind(run_id)
            .bind(&summary)
            .bind(res.message_id)
            .bind(&tools)
            .bind(res.tokens_in)
            .bind(res.tokens_out)
            .execute(&pool)
            .await;
            if job.notify {
                // The full report is the notification body — you read it by
                // opening the notification, not by jumping into a chat thread.
                notify_owner(&pool, &job, &res.assistant_text, conv_id, "info").await;
            }
            log::info!("cron job {} succeeded", job.id);
        }
        Ok(Err(e)) => {
            let _ = sqlx::query(
                "UPDATE db_cron_runs SET status='error', finished_at=NOW(), error=$2 WHERE id=$1",
            )
            .bind(run_id)
            .bind(&e)
            .execute(&pool)
            .await;
            if job.notify {
                notify_owner(&pool, &job, &format!("Failed: {e}"), conv_id, "error").await;
            }
            log::error!("cron job {} errored: {e}", job.id);
        }
        Err(_) => {
            let _ = sqlx::query(
                "UPDATE db_cron_runs SET status='timeout', finished_at=NOW(), \
                    error='exceeded max_runtime_secs' WHERE id=$1",
            )
            .bind(run_id)
            .execute(&pool)
            .await;
            if job.notify {
                notify_owner(&pool, &job, "Timed out before finishing", conv_id, "error").await;
            }
            log::error!("cron job {} timed out", job.id);
        }
    }
}

/// Deliver the job's report to the owner via the shared `notify()` helper: a
/// persisted inbox row (header bell) whose BODY is the full report — opening
/// the notification shows it, no chat deep-link. Push fan-out per the job's
/// `notify_channels` (honoring the user's channel prefs inside `notify`; the
/// push body is truncated there). `conversation_id` is kept in metadata for
/// reference only. Bus is None — the worker is a separate process, so the
/// client surfaces it on its next unread-count refetch rather than via SSE.
async fn notify_owner(pool: &DbPool, job: &CronJobRow, body: &str, conv_id: Uuid, level: &str) {
    let n = NewNotification::new(&job.user_id, "cron", &job.title)
        .level(level)
        .body(body)
        .metadata(json!({ "job_id": job.id, "conversation_id": conv_id }));
    notify(pool, None, n, Channels::from_list(&job.notify_channels)).await;
}

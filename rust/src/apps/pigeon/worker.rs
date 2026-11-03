//! The pigeon-worker's loops: what runs whoever is looking. Triage (every 5 s, a few at once),
//! the channels' own background work (Gmail's polling), the incoming messages pushed to the phone,
//! the sweeps (expired drafts, rule runs and questions), and per user the morning summary and the
//! health checks. The LLM's calls aren't `Send` (the providers' stream sender), so everything that
//! may write with it runs on this thread's LocalSet (`spawn_local`).

use std::time::{Duration, Instant};

use tokio::task::spawn_local;

use crate::apps::pigeon::events::{kinds, Bus};
use crate::apps::pigeon::state::{self, AppState};
use crate::apps::pigeon::{actions, cards, health, rules, slugs, summary, triage};
use crate::db::db::DbPool;

/// Run until the process ends. Call inside a `LocalSet`.
pub async fn run(pool: DbPool) {
    let st = state::shared(&pool);
    for c in &st.connectors {
        match c.available(&st) {
            Ok(()) => c.start(st.clone()),
            Err(why) => log::info!("pigeon: {} off: {why}", c.id()),
        }
    }
    if st.jev.is_none() {
        log::warn!("pigeon: Jev isn't configured (PIGEON_JEV_*): messages are shown, not sorted");
    }
    spawn_local(pushes(st.clone()));
    spawn_local(sweeps(st.clone()));
    spawn_local(per_user(st.clone()));
    loop {
        if let Err(e) = triage::run_due(&st).await {
            log::warn!("pigeon triage: {e:#}");
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
    }
}

/// Each message from someone, to the phone.
async fn pushes(st: AppState) {
    let bus = Bus::start(st.pool.clone());
    let mut rx = bus.subscribe();
    loop {
        match rx.recv().await {
            Ok(ev) if ev.kind == kinds::MESSAGE_IN => {
                if let Some(item) = ev.id {
                    if let Err(e) = cards::message_in(&st, &ev.user_id, item).await {
                        log::warn!("pigeon push of {item}: {e:#}");
                    }
                }
            }
            Ok(_) => {}
            Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => log::warn!("pigeon pushes: {n} event(s) missed"),
            Err(tokio::sync::broadcast::error::RecvError::Closed) => return,
        }
    }
}

/// Every minute: what nobody decided in time expires; hourly, slugs for the newly named.
async fn sweeps(st: AppState) {
    let mut slugs_at: Option<Instant> = None;
    loop {
        match actions::expire_due(&st).await {
            Ok(n) if n > 0 => log::info!("pigeon: {n} pending action(s) expired"),
            Ok(_) => {}
            Err(e) => log::warn!("pigeon: expiring actions: {e:#}"),
        }
        match rules::expire_due(&st).await {
            Ok(n) if n > 0 => log::info!("pigeon: {n} pending rule run(s) expired"),
            Ok(_) => {}
            Err(e) => log::warn!("pigeon: expiring rule runs: {e:#}"),
        }
        if let Err(e) = cards::sweep(&st).await {
            log::warn!("pigeon: expiring questions: {e:#}");
        }
        if slugs_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(3600)) {
            match slugs::backfill(&st).await {
                Ok(n) if n > 0 => log::info!("pigeon: {n} contact(s) got a slug"),
                Ok(_) => {}
                Err(e) => log::warn!("pigeon slugs: {e:#}"),
            }
            slugs_at = Some(Instant::now());
        }
        tokio::time::sleep(Duration::from_secs(60)).await;
    }
}

/// Every minute for each user with a channel connected: the morning summary when it's due;
/// every two, the health checks.
async fn per_user(st: AppState) {
    let mut n: u64 = 0;
    loop {
        tokio::time::sleep(Duration::from_secs(60)).await;
        n += 1;
        let users: Vec<String> = match sqlx::query_scalar("SELECT DISTINCT user_id FROM db_pigeon_connections WHERE status <> 'disconnected'")
            .fetch_all(&st.pool)
            .await
        {
            Ok(u) => u,
            Err(e) => {
                log::warn!("pigeon: users: {e:#}");
                continue;
            }
        };
        for user in &users {
            if let Err(e) = summary::tick(&st, user).await {
                log::warn!("pigeon summary for {user}: {e:#}");
            }
            if n % 2 == 0 {
                if let Err(e) = health::check(&st, user).await {
                    log::warn!("pigeon health for {user}: {e:#}");
                }
            }
        }
    }
}

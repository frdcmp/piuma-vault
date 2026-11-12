//! The pigeon-worker's loops: what runs whoever is looking. Triage (every 5 s, a few at once),
//! the channels' own background work (Gmail's polling), the incoming messages pushed to the phone,
//! the sweeps (expired drafts, rule runs and questions, aways and grants past their end), and per user the
//! health checks. The LLM's calls aren't `Send` (the providers' stream sender), so everything that
//! may write with it runs on this thread's LocalSet (`spawn_local`).

use std::time::{Duration, Instant};

use tokio::task::spawn_local;

use crate::apps::pigeon::events::{kinds, Bus};
use crate::apps::pigeon::state::{self, AppState};
use crate::apps::pigeon::{access, actions, avatars, away, cards, health, listen, media, rules, slugs, triage};
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
    // permissions granted under a name the catalogue has since changed
    match access::renames(&st.pool).await {
        Ok(n) if n > 0 => log::info!("pigeon: {n} grant(s) renamed"),
        Ok(_) => {}
        Err(e) => log::warn!("pigeon: renaming grants: {e:#}"),
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

/// Every minute: what nobody decided in time expires, files not stored yet are tried again;
/// hourly, files past their keeping time leave storage (every minute while there are more), slugs
/// for the newly named.
async fn sweeps(st: AppState) {
    let mut slugs_at: Option<Instant> = None;
    let mut media_at: Option<Instant> = None;
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
        // aways past their end: back, with what happened meanwhile
        match away::expire_due(&st).await {
            Ok(n) if n > 0 => log::info!("pigeon: {n} away(s) ended"),
            Ok(_) => {}
            Err(e) => log::warn!("pigeon: ending aways: {e:#}"),
        }
        // grants, places in a group and the pause past their end
        match access::sweep(&st).await {
            Ok(n) if n > 0 => log::info!("pigeon: {n} grant(s) ended"),
            Ok(_) => {}
            Err(e) => log::warn!("pigeon: ending grants: {e:#}"),
        }
        // people's profile pictures: the new ones, and weekly again
        match avatars::sweep(&st).await {
            Ok(n) if n > 0 => log::info!("pigeon: {n} profile picture(s) kept"),
            Ok(_) => {}
            Err(e) => log::warn!("pigeon avatars: {e:#}"),
        }
        // files that didn't make it into storage yet
        if let Err(e) = media::retry(&st).await {
            log::warn!("pigeon media: {e:#}");
        }
        // voice notes not heard yet (a failed try, a restart)
        match listen::retry(&st).await {
            Ok(n) if n > 0 => log::info!("pigeon: {n} voice note(s) heard again"),
            Ok(_) => {}
            Err(e) => log::warn!("pigeon listen: {e:#}"),
        }
        // files past their keeping time leave storage
        if media_at.is_none_or(|t| t.elapsed() >= Duration::from_secs(3600)) {
            match media::expire(&st).await {
                Ok(n) if n > 0 => log::info!("pigeon: the files of {n} message(s) expired"),
                Ok(_) => media_at = Some(Instant::now()),
                Err(e) => log::warn!("pigeon media expiry: {e:#}"),
            }
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

/// Every two minutes for each user with a channel connected: the health checks.
async fn per_user(st: AppState) {
    loop {
        tokio::time::sleep(Duration::from_secs(120)).await;
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
            if let Err(e) = health::check(&st, user).await {
                log::warn!("pigeon health for {user}: {e:#}");
            }
        }
    }
}

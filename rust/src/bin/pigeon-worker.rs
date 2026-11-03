//! Pigeon Worker — the Inbox's background work (`apps::pigeon::worker`): triage, Gmail's polling,
//! the pushes, the sweeps, the morning summary and the health checks. Pigeon's LLM calls hold the
//! providers' stream sender (not `Send`), so it runs on a current-thread runtime + LocalSet.

use backend::apps::pigeon::worker;
use backend::db;

fn main() {
    env_logger::init();
    log::info!("🕊 Pigeon Worker starting...");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("build current-thread runtime");
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async {
        let pool = match db::db::create_pool().await {
            Ok(p) => p,
            Err(e) => {
                log::error!("❌ Failed to connect to database: {e}");
                std::process::exit(1);
            }
        };
        worker::run(pool).await;
    });
}

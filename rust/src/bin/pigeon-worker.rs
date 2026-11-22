//! Pigeon Worker — the Inbox's background work (`apps::pigeon::worker`): triage, Gmail's polling,
//! the pushes, the sweeps and the health checks. Pigeon's LLM calls hold the
//! providers' stream sender (not `Send`), so it runs on a current-thread runtime + LocalSet.

use backend::apps::pigeon::worker;
use backend::db;

fn main() {
    env_logger::init();
    log::info!("🕊 Pigeon Worker starting...");
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("build current-thread runtime");
    let local = tokio::task::LocalSet::new();
    local.block_on(&rt, async {
        backend::apps::telemetry::init();
        let pool = match db::db::create_pool().await {
            Ok(p) => p,
            Err(e) => {
                log::error!("❌ Failed to connect to database: {e}");
                std::process::exit(1);
            }
        };
        // `pigeon-worker to-notes`: the one-off that copies what Pigeon knew about people into
        // their folders in the vault, then ends
        if std::env::args().nth(1).as_deref() == Some("to-notes") {
            let st = backend::apps::pigeon::state::shared(&pool);
            match backend::apps::pigeon::people::to_notes(&st).await {
                Ok(done) => println!("{done}"),
                Err(e) => {
                    eprintln!("to-notes: {e:#}");
                    std::process::exit(1);
                }
            }
            return;
        }
        // `pigeon-worker facts-from-notes`: the one-off that turns the Memory notes Pigeon kept on
        // people into facts in the vault's memory, then ends
        if std::env::args().nth(1).as_deref() == Some("facts-from-notes") {
            let st = backend::apps::pigeon::state::shared(&pool);
            match backend::apps::pigeon::known::from_notes(&st).await {
                Ok(done) => println!("{done}"),
                Err(e) => {
                    eprintln!("facts-from-notes: {e:#}");
                    std::process::exit(1);
                }
            }
            return;
        }
        // `pigeon-worker facts-review`: the one-off that reads every person's facts again against
        // what Pigeon keeps and rejects what isn't that, then ends
        if std::env::args().nth(1).as_deref() == Some("facts-review") {
            let st = backend::apps::pigeon::state::shared(&pool);
            match backend::apps::pigeon::known::review(&st).await {
                Ok(done) => println!("{done}"),
                Err(e) => {
                    eprintln!("facts-review: {e:#}");
                    std::process::exit(1);
                }
            }
            return;
        }
        worker::run(pool).await;
    });
}

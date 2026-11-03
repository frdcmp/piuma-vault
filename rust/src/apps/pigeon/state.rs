//! What Pigeon's handlers, workers and connectors share: the pool, the settings, Jev, the
//! connectors. One per process (`shared`): the backend's, or the pigeon-worker's.

use std::sync::{Arc, OnceLock};

use super::ai::jev::Jev;
use super::config::Config;
use super::connectors::{self, Connector};
use crate::db::db::DbPool;

pub struct State {
    pub pool: DbPool,
    pub cfg: Config,
    pub jev: Option<Jev>,
    pub connectors: Vec<Arc<dyn Connector>>,
}

pub type AppState = Arc<State>;

static SHARED: OnceLock<AppState> = OnceLock::new();

/// The process's state, made on first use from the environment.
pub fn shared(pool: &DbPool) -> AppState {
    SHARED
        .get_or_init(|| {
            let cfg = Config::from_env();
            Arc::new(State { jev: cfg.jev.as_ref().map(Jev::new), connectors: connectors::all(), pool: pool.clone(), cfg })
        })
        .clone()
}

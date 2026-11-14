//! Pigeon's tools for Piuma: the Inbox (conversations, drafts, people, rules, switches). They live
//! in `apps::pigeon::tools`; here they join the catalogue.

use serde_json::Value;

use crate::db::db::DbPool;

pub const PREFIX: &str = "pigeon_";

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    crate::apps::pigeon::tools::defs()
}

pub async fn call(pool: &DbPool, user_id: &str, name: &str, args: &Value) -> Result<Value, String> {
    let st = crate::apps::pigeon::state::shared(pool);
    crate::apps::pigeon::tools::call_as(&st, user_id, name, args, "Piuma".into()).await
}

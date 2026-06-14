//! Database backup tool. Dumps every table in the `public` schema and uploads
//! the SQL file to the S3 `dump/` prefix — the same backup the admin DB Backups
//! page produces. Read-only against the DB (it only COPYs data out), so it is
//! NOT a destructive tool. Mainly intended for scheduled (cron) backups.

use serde_json::{json, Value};

use super::*;
use crate::apps::db_dump::handlers::run_dump;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "backup_database",
        "Back up the entire PostgreSQL database to S3 storage (the dump/ folder), \
         identical to the admin DB Backups page. Returns the backup filename, size \
         and the number of tables/rows captured. Safe and read-only — it never \
         modifies data. Use it for on-demand or scheduled backups.",
        json!({ "type": "object", "properties": {} }),
    )]
}

pub async fn backup_database(pool: &DbPool, _args: &Value) -> Result<Value, String> {
    let resp = run_dump(pool).await?;
    Ok(json!({
        "ok": true,
        "filename": resp.filename,
        "size_bytes": resp.size,
        "tables": resp.tables,
        "rows": resp.rows,
        "created_at": resp.created_at,
    }))
}

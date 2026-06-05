//! Tag↔entity link sync, shared by the tasks + calendar write paths (HTTP
//! handlers and agent tools). Tags are referenced by name on the wire; this
//! find-or-creates each name in `db_tags` (uncategorized — virtual Inbox) and
//! rewrites the entity's rows in the given join table to match exactly.

use std::collections::HashSet;
use uuid::Uuid;

use crate::db::db::DbPool;

/// Resolve a bucket (task group) by name for this user, creating it if missing.
/// Used by the agent tools so the model can drop a task into a bucket by name.
pub async fn find_or_create_bucket(
    pool: &DbPool,
    user_id: &str,
    name: &str,
) -> Result<Uuid, sqlx::Error> {
    let name = name.trim();
    if let Some(id) = sqlx::query_scalar::<_, Uuid>(
        "SELECT id FROM db_buckets WHERE user_id = $1 AND lower(name) = lower($2)",
    )
    .bind(user_id)
    .bind(name)
    .fetch_optional(pool)
    .await?
    {
        return Ok(id);
    }
    sqlx::query_scalar::<_, Uuid>(
        "INSERT INTO db_buckets (user_id, name) VALUES ($1, $2) RETURNING id",
    )
    .bind(user_id)
    .bind(name)
    .fetch_one(pool)
    .await
}

/// Replace an entity's tags with `names` (by name; unknown names are created
/// uncategorized). `link_table`/`id_col` identify the join table, e.g.
/// ("db_task_tags", "task_id"). Names are trimmed + lowercased + de-duped.
/// Caller-supplied table/column identifiers are internal constants — never user
/// input — so the formatted SQL is safe.
pub async fn sync_tags(
    pool: &DbPool,
    user_id: &str,
    link_table: &str,
    id_col: &str,
    entity_id: Uuid,
    names: &[String],
) -> Result<(), sqlx::Error> {
    // Normalize + de-dupe.
    let mut seen = HashSet::new();
    let norm: Vec<String> = names
        .iter()
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && seen.insert(s.clone()))
        .collect();

    // Reset existing links for this entity.
    sqlx::query(&format!("DELETE FROM {link_table} WHERE {id_col} = $1"))
        .bind(entity_id)
        .execute(pool)
        .await?;

    if norm.is_empty() {
        return Ok(());
    }

    // Find-or-create each tag name (uncategorized by default).
    sqlx::query(
        "INSERT INTO db_tags (user_id, name) \
         SELECT $1, n FROM UNNEST($2::text[]) AS n \
         ON CONFLICT (user_id, lower(name)) DO NOTHING",
    )
    .bind(user_id)
    .bind(&norm)
    .execute(pool)
    .await?;

    // Link them.
    sqlx::query(&format!(
        "INSERT INTO {link_table} ({id_col}, tag_id) \
         SELECT $1, tg.id FROM db_tags tg \
         WHERE tg.user_id = $2 AND lower(tg.name) = ANY($3::text[]) \
         ON CONFLICT DO NOTHING"
    ))
    .bind(entity_id)
    .bind(user_id)
    .bind(&norm)
    .execute(pool)
    .await?;

    Ok(())
}

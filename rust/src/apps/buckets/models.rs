use chrono::{DateTime, Utc};
use serde::{Deserialize, Deserializer, Serialize};
use sqlx::FromRow;

// ── DB models ──

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Bucket {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// Tags are flat, independent labels (NOT grouped by bucket — buckets group
// tasks directly via db_tasks.bucket_id). The registry maps each name to a colour.
#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Tag {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
    pub created_at: Option<DateTime<Utc>>,
    pub updated_at: Option<DateTime<Utc>>,
}

// ── Request DTOs ──

#[derive(Debug, Deserialize)]
pub struct CreateBucketRequest {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateBucketRequest {
    pub name: Option<String>,
    // Three-state: omitted = keep, null = clear, value = set.
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct CreateTagRequest {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTagRequest {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

// ── Error ──

#[derive(Debug, Serialize)]
pub struct BucketsApiError {
    pub error: String,
}

// Distinguish "field omitted" (outer None) from "explicit null" (Some(None)) in
// PATCH bodies. serde only calls this when the key is present, so the `default`
// supplies None for an omitted field.
fn double_option<'de, T, D>(de: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: Deserializer<'de>,
{
    Ok(Some(Option::deserialize(de)?))
}

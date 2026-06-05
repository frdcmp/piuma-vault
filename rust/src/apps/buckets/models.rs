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

#[derive(Debug, Serialize, Deserialize, FromRow, Clone)]
pub struct Tag {
    pub id: uuid::Uuid,
    pub user_id: String,
    pub bucket_id: Option<uuid::Uuid>,
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
    pub bucket_id: Option<uuid::Uuid>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub sort_order: i32,
}

#[derive(Debug, Deserialize)]
pub struct UpdateTagRequest {
    pub name: Option<String>,
    // Three-state: omitted = keep, null = move to Inbox (uncategorized), value = move to bucket.
    #[serde(default, deserialize_with = "double_option")]
    pub bucket_id: Option<Option<uuid::Uuid>>,
    #[serde(default, deserialize_with = "double_option")]
    pub color: Option<Option<String>>,
    pub sort_order: Option<i32>,
}

#[derive(Debug, Deserialize)]
pub struct TreeQuery {
    // "tasks" | "calendar" — which surface to count tag usage against. Omitted = no counts.
    pub counts: Option<String>,
}

// ── Tree response (filter UI feed) ──

#[derive(Debug, Serialize)]
pub struct TagNode {
    pub id: uuid::Uuid,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
    pub count: i64,
}

#[derive(Debug, Serialize)]
pub struct BucketNode {
    pub id: uuid::Uuid,
    pub name: String,
    pub color: Option<String>,
    pub sort_order: i32,
    pub tags: Vec<TagNode>,
}

#[derive(Debug, Serialize)]
pub struct TreeResponse {
    pub buckets: Vec<BucketNode>,
    // NULL-bucket tags — the virtual "Inbox" group.
    pub inbox: Vec<TagNode>,
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

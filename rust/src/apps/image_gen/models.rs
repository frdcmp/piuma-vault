use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

/// POST /images/generate body. `size`/`n` are optional (defaults applied).
#[derive(Debug, Deserialize)]
pub struct GenerateRequest {
    pub prompt: String,
    pub size: Option<String>,
    pub n: Option<u8>,
}

/// A stored generated image — a `db_generated_images` row plus the freshly
/// resolved delivery URL. Returned by the API and (the `url` of) the agent tool.
#[derive(Debug, Serialize)]
pub struct StoredImage {
    pub id: Uuid,
    pub prompt: String,
    pub revised_prompt: Option<String>,
    pub provider: String,
    pub model: String,
    pub size: String,
    pub storage_key: String,
    pub cdn_url: String,
    pub mime: String,
    pub source: String,
}

/// A `db_generated_images` row (history listing).
#[derive(Debug, Serialize, FromRow)]
pub struct GeneratedImageRow {
    pub id: Uuid,
    pub prompt: String,
    pub revised_prompt: Option<String>,
    pub provider: String,
    pub model: String,
    pub size: String,
    pub storage_key: String,
    pub cdn_url: String,
    pub mime: String,
    pub source: String,
    pub created_at: DateTime<Utc>,
}

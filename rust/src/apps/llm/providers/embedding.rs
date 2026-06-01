use log::{error, info};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use crate::apps::settings::store;
use crate::db::db::DbPool;

/// Azure OpenAI Embedding API request body
#[derive(Serialize)]
struct EmbeddingRequest {
    input: String,
    model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    dimensions: Option<u32>,
}

#[derive(Deserialize, Debug)]
struct EmbeddingResponse {
    data: Vec<EmbeddingData>,
}

#[derive(Deserialize, Debug)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

/// Fetch a text embedding from Azure OpenAI.
///
/// Endpoint URL and API key are resolved from the `app_settings` table (set via
/// the Services dashboard). Requests `dimensions` as specified.
pub async fn embed(pool: &DbPool, text: &str, dimensions: u32) -> Result<Vec<f32>, String> {
    let (url, api_key) = store::embedding_config(pool).await?;
    embed_with(text, dimensions, &url, &api_key).await
}

/// Same as [`embed`], but with an explicit endpoint URL + API key instead of
/// resolving them from the DB. Used by the Services "try now" check so admins
/// can validate unsaved credentials before persisting them.
pub async fn embed_with(
    text: &str,
    dimensions: u32,
    url: &str,
    api_key: &str,
) -> Result<Vec<f32>, String> {
    let body = EmbeddingRequest {
        input: text.to_string(),
        model: "text-embedding-3-large".to_string(),
        dimensions: Some(dimensions),
    };

    info!("[embedding] requesting embedding ({} chars)", text.len());

    let client = Client::new();
    let res = client
        .post(url)
        .header("api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| {
            error!("[embedding] connection error: {}", e);
            format!("Connection error: {}", e)
        })?;

    let status = res.status();
    if !status.is_success() {
        let text = res.text().await.unwrap_or_else(|_| "unknown".to_string());
        error!("[embedding] API error ({}): {}", status, text);
        return Err(format!("API error: {}", text));
    }

    let parsed: EmbeddingResponse = res
        .json()
        .await
        .map_err(|e| format!("Failed to parse embedding response: {}", e))?;

    parsed
        .data
        .into_iter()
        .next()
        .map(|d| d.embedding)
        .ok_or_else(|| "No embedding in response".to_string())
}

/// Lightweight cache key hasher from a search string
pub fn cache_key(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.trim().to_lowercase().hash(&mut hasher);
    format!("emb:query:{}", hasher.finish())
}

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
    #[serde(default)]
    usage: Option<EmbeddingUsage>,
}

#[derive(Deserialize, Debug)]
struct EmbeddingData {
    embedding: Vec<f32>,
}

#[derive(Deserialize, Debug, Default)]
struct EmbeddingUsage {
    #[serde(default)]
    prompt_tokens: i64,
}

/// The Azure deployment used for all embeddings; logged as the `model` in the
/// token-usage ledger so embedding spend is attributable per provider/model.
pub const EMBED_MODEL: &str = "text-embedding-3-large";

/// Fetch a text embedding from Azure OpenAI and record its token usage.
///
/// Endpoint URL and API key are resolved from the `app_settings` table (set via
/// the Services dashboard). `source` tags the call site for the admin analytics
/// page (e.g. `embedding:notes`, `embedding:memory`, `embedding:search`,
/// `embedding:chat`). Logging failures are swallowed — they never block embedding.
pub async fn embed(
    pool: &DbPool,
    text: &str,
    dimensions: u32,
    source: &str,
) -> Result<Vec<f32>, String> {
    let (url, api_key) = store::embedding_config(pool).await?;
    let (embedding, tokens) = embed_with(text, dimensions, &url, &api_key).await?;
    if tokens > 0 {
        let _ = sqlx::query(
            "INSERT INTO db_token_usage (kind, source, provider_kind, model, tokens_input) \
             VALUES ('embedding', $1, 'azure', $2, $3)",
        )
        .bind(source)
        .bind(EMBED_MODEL)
        .bind(tokens as i32)
        .execute(pool)
        .await;
    }
    Ok(embedding)
}

/// Same as [`embed`], but with an explicit endpoint URL + API key instead of
/// resolving them from the DB, and without usage logging. Returns the embedding
/// vector plus the prompt token count reported by the API. Used by the Services
/// "try now" check so admins can validate unsaved credentials before saving.
pub async fn embed_with(
    text: &str,
    dimensions: u32,
    url: &str,
    api_key: &str,
) -> Result<(Vec<f32>, i64), String> {
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

    let tokens = parsed.usage.map(|u| u.prompt_tokens).unwrap_or(0);
    parsed
        .data
        .into_iter()
        .next()
        .map(|d| (d.embedding, tokens))
        .ok_or_else(|| "No embedding in response".to_string())
}

/// Lightweight cache key hasher from a search string
pub fn cache_key(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    text.trim().to_lowercase().hash(&mut hasher);
    format!("emb:query:{}", hasher.finish())
}

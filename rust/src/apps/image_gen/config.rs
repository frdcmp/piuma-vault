//! Runtime config for image generation, resolved from `app_settings`
//! (admin → Services → Images). Mirrors `apps::web_search`: the active provider
//! is `imagegen_provider`; each provider's key/model lives in its own setting.

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::apps::settings::store;
use crate::db::db::DbPool;

use super::providers::{self, GenOptions};

pub const DEFAULT_PROVIDER: &str = "openai";

/// Resolved provider config (key present; model/base defaulted).
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub kind: String,
    pub api_key: String,
    pub base_url: Option<String>,
    pub model: String,
}

/// Default model for a provider when none is configured.
fn default_model(kind: &str) -> &'static str {
    match kind {
        "openai" => "gpt-image-1",
        "gemini" => "imagen-3.0-generate-002",
        // Stability's `core` endpoint has no model id; the field is unused.
        _ => "",
    }
}

/// Resolve the active provider config. Errors if the provider's key is unset.
pub async fn resolve(pool: &DbPool) -> Result<ResolvedConfig, String> {
    resolve_with(pool, None, None, None).await
}

/// Like [`resolve`], but lets the Services "try now" check supply an unsaved
/// provider/key/model. Blank overrides fall back to the saved config.
pub async fn resolve_with(
    pool: &DbPool,
    provider_ov: Option<String>,
    key_ov: Option<String>,
    model_ov: Option<String>,
) -> Result<ResolvedConfig, String> {
    let kind = provider_ov
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim().to_string())
        .or(store::get(pool, store::IMAGEGEN_PROVIDER).await)
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());

    let (key_setting, model_setting, base_setting) = match kind.as_str() {
        "openai" => (
            store::IMAGEGEN_OPENAI_API_KEY,
            Some(store::IMAGEGEN_OPENAI_MODEL),
            Some(store::IMAGEGEN_OPENAI_BASE),
        ),
        "gemini" => (
            store::IMAGEGEN_GEMINI_API_KEY,
            Some(store::IMAGEGEN_GEMINI_MODEL),
            None,
        ),
        "stability" => (store::IMAGEGEN_STABILITY_API_KEY, None, None),
        other => return Err(format!("unknown image provider: {other}")),
    };

    let api_key = match key_ov.filter(|k| !k.trim().is_empty()) {
        Some(k) => k.trim().to_string(),
        None => store::get(pool, key_setting)
            .await
            .ok_or_else(|| format!("{kind} API key not set — add it in admin → Services"))?,
    };

    let model = match model_ov.filter(|m| !m.trim().is_empty()) {
        Some(m) => m.trim().to_string(),
        None => match model_setting {
            Some(s) => store::get(pool, s)
                .await
                .unwrap_or_else(|| default_model(&kind).to_string()),
            None => default_model(&kind).to_string(),
        },
    };
    let base_url = match base_setting {
        Some(s) => store::get(pool, s).await,
        None => None,
    };

    Ok(ResolvedConfig {
        kind,
        api_key,
        base_url,
        model,
    })
}

/// List the image-capable models for the configured (or overridden) provider,
/// using its saved/unsaved key. Powers the Services "Fetch models" picker.
pub async fn list_models(
    pool: &DbPool,
    provider_ov: Option<String>,
    key_ov: Option<String>,
) -> Result<Vec<String>, String> {
    let cfg = resolve_with(pool, provider_ov, key_ov, None).await?;
    providers::list_models(&cfg.kind, &cfg.api_key, cfg.base_url.as_deref()).await
}

/// Live-check the configured (or overridden) provider by generating one small
/// image — not stored. Returns `(message, data_url)` so the Services panel can
/// show a verdict and a preview of the generated image.
pub async fn test(
    pool: &DbPool,
    provider_ov: Option<String>,
    key_ov: Option<String>,
    model_ov: Option<String>,
) -> Result<(String, String), String> {
    let cfg = resolve_with(pool, provider_ov, key_ov, model_ov).await?;
    let opts = GenOptions {
        prompt: "a small red circle centered on a plain white background",
        size: "1024x1024",
        n: 1,
        model: &cfg.model,
    };
    let images = providers::generate(&cfg.kind, &cfg.api_key, cfg.base_url.as_deref(), &opts).await?;
    let first = images.first().ok_or("provider returned no image")?;
    let message = format!(
        "OK — {} generated 1 image ({} KB, {})",
        cfg.kind,
        first.bytes.len() / 1024,
        first.mime
    );
    let data_url = format!("data:{};base64,{}", first.mime, STANDARD.encode(&first.bytes));
    Ok((message, data_url))
}

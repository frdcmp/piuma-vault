//! Runtime config for the voice agent, resolved from `app_settings`
//! (admin → Services → Voice). Mirrors `apps::image_gen`: the active provider is
//! `voice_provider`; each provider's key/model/voice lives in its own setting.

use crate::apps::settings::store;
use crate::db::db::DbPool;

use super::providers;

pub const DEFAULT_PROVIDER: &str = "gemini";

/// Resolved provider config (key present; model defaulted).
#[derive(Debug, Clone)]
pub struct ResolvedConfig {
    pub kind: String,
    pub api_key: String,
    pub model: String,
}

/// Default model for a provider when none is configured.
fn default_model(kind: &str) -> &'static str {
    match kind {
        "gemini" => "gemini-3.8-live",
        _ => "",
    }
}

/// Resolve the active provider config, letting the Services "try now" check
/// supply an unsaved provider/key/model. Blank overrides fall back to the saved
/// config. Errors if the provider's key is unset.
pub async fn resolve_with(
    pool: &DbPool,
    provider_ov: Option<String>,
    key_ov: Option<String>,
    model_ov: Option<String>,
) -> Result<ResolvedConfig, String> {
    let kind = provider_ov
        .filter(|p| !p.trim().is_empty())
        .map(|p| p.trim().to_string())
        .or(store::get(pool, store::VOICE_PROVIDER).await)
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());

    let (key_setting, model_setting) = match kind.as_str() {
        "gemini" => (store::VOICE_GEMINI_API_KEY, store::VOICE_GEMINI_MODEL),
        other => return Err(format!("unknown voice provider: {other}")),
    };

    let api_key = match key_ov.filter(|k| !k.trim().is_empty()) {
        Some(k) => k.trim().to_string(),
        None => store::get(pool, key_setting)
            .await
            .ok_or_else(|| format!("{kind} API key not set — add it in admin → Services"))?,
    };

    let model = match model_ov.filter(|m| !m.trim().is_empty()) {
        Some(m) => m.trim().to_string(),
        None => store::get(pool, model_setting)
            .await
            .unwrap_or_else(|| default_model(&kind).to_string()),
    };

    Ok(ResolvedConfig { kind, api_key, model })
}

/// List the realtime-capable models for the configured (or overridden)
/// provider, using its saved/unsaved key. Powers the Services "Fetch models"
/// picker.
pub async fn list_models(
    pool: &DbPool,
    provider_ov: Option<String>,
    key_ov: Option<String>,
) -> Result<Vec<String>, String> {
    let cfg = resolve_with(pool, provider_ov, key_ov, None).await?;
    providers::list_models(&cfg.kind, &cfg.api_key).await
}

/// Live-check the configured (or overridden) provider: the key works and the
/// chosen model supports realtime speech-to-speech. Opens no audio session.
pub async fn test(
    pool: &DbPool,
    provider_ov: Option<String>,
    key_ov: Option<String>,
    model_ov: Option<String>,
) -> Result<String, String> {
    let cfg = resolve_with(pool, provider_ov, key_ov, model_ov).await?;
    providers::test(&cfg.kind, &cfg.api_key, &cfg.model).await
}

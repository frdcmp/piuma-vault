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
pub fn default_model(kind: &str) -> &'static str {
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

/// A voice provider's rate card, USD per 1M tokens. Live models bill audio
/// and text at different rates; thinking tokens bill as text output.
#[derive(Debug, Clone, Copy)]
pub struct VoicePrices {
    pub text_input: f64,
    pub text_output: f64,
    pub audio_input: f64,
    pub audio_output: f64,
}

impl VoicePrices {
    /// Cost of `input`/`output` tokens, of which `*_audio` are audio.
    pub fn cost(&self, input: i64, output: i64, input_audio: i64, output_audio: i64) -> f64 {
        let text_in = (input - input_audio).max(0) as f64;
        let text_out = (output - output_audio).max(0) as f64;
        (text_in * self.text_input
            + input_audio as f64 * self.audio_input
            + text_out * self.text_output
            + output_audio as f64 * self.audio_output)
            / 1_000_000.0
    }
}

/// The configured rate card for provider `kind`, or `None` when any of its
/// four prices is unset (voice usage then shows as unpriced, never guessed).
pub async fn prices(pool: &DbPool, kind: &str) -> Option<VoicePrices> {
    let keys = match kind {
        "gemini" => [
            store::VOICE_GEMINI_PRICE_TEXT_INPUT,
            store::VOICE_GEMINI_PRICE_TEXT_OUTPUT,
            store::VOICE_GEMINI_PRICE_AUDIO_INPUT,
            store::VOICE_GEMINI_PRICE_AUDIO_OUTPUT,
        ],
        _ => return None,
    };
    let mut values = [0.0; 4];
    for (value, key) in values.iter_mut().zip(keys) {
        *value = store::get(pool, key).await?.trim().parse().ok()?;
    }
    Some(VoicePrices {
        text_input: values[0],
        text_output: values[1],
        audio_input: values[2],
        audio_output: values[3],
    })
}

/// Voice providers with an adapter — the ones a rate card can exist for.
pub const PROVIDERS: &[&str] = &["gemini"];

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

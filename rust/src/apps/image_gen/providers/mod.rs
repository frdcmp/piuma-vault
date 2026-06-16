//! Provider-agnostic image generation. Each adapter turns a provider's response
//! into the common [`GeneratedImage`] (decoded bytes + mime). The active
//! provider/key/model are resolved in `super::config`.

mod gemini;
mod openai;
mod stability;

/// Request options passed to every adapter.
pub struct GenOptions<'a> {
    pub prompt: &'a str,
    /// `"WxH"`, e.g. `"1024x1024"`. Providers that take an aspect ratio derive
    /// it via [`aspect_ratio`].
    pub size: &'a str,
    /// Images to produce (callers clamp; adapters honour what the provider allows).
    pub n: u8,
    /// Provider-specific model id (ignored by providers without one).
    pub model: &'a str,
}

/// A generated image, decoded to raw bytes.
pub struct GeneratedImage {
    pub bytes: Vec<u8>,
    pub mime: String,
    pub revised_prompt: Option<String>,
}

/// List the image-capable models a provider exposes for the given key, sorted.
/// Stability's `core` endpoint has no model id, so it returns an empty list.
pub async fn list_models(
    kind: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut ids = match kind {
        "openai" => openai::list_models(api_key, base_url).await?,
        "gemini" => gemini::list_models(api_key, base_url).await?,
        "stability" => Vec::new(),
        other => return Err(format!("unknown image provider: {other}")),
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

/// Dispatch to the configured provider.
pub async fn generate(
    kind: &str,
    api_key: &str,
    base_url: Option<&str>,
    opts: &GenOptions<'_>,
) -> Result<Vec<GeneratedImage>, String> {
    match kind {
        "openai" => openai::generate(api_key, base_url, opts).await,
        "gemini" => gemini::generate(api_key, base_url, opts).await,
        "stability" => stability::generate(api_key, base_url, opts).await,
        other => Err(format!("unknown image provider: {other}")),
    }
}

/// Map a `"WxH"` size to a coarse aspect ratio supported by both Imagen and
/// Stability (`1:1` / `16:9` / `9:16`). Defaults to square on a bad value.
pub(crate) fn aspect_ratio(size: &str) -> &'static str {
    let mut parts = size.split(['x', 'X']);
    let w = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
    let h = parts.next().and_then(|s| s.trim().parse::<u32>().ok());
    match (w, h) {
        (Some(w), Some(h)) if w > h => "16:9",
        (Some(w), Some(h)) if w < h => "9:16",
        _ => "1:1",
    }
}

/// File extension for a mime type (used when building the S3 key).
pub fn ext_for_mime(mime: &str) -> &'static str {
    match mime {
        "image/jpeg" | "image/jpg" => "jpg",
        "image/webp" => "webp",
        _ => "png",
    }
}

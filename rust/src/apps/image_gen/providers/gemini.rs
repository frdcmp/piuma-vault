//! Google image generation via the Gemini API. Two model families, two shapes:
//!   - **Imagen** (`imagen-*`) → `:predict`, `predictions[].bytesBase64Encoded`.
//!   - **Gemini image** (e.g. `gemini-2.5-flash-image`, "Nano Banana") →
//!     `:generateContent`, `candidates[].content.parts[].inlineData`.
//! `generate` picks the path from the model id.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use super::{aspect_ratio, GenOptions, GeneratedImage};

const DEFAULT_BASE: &str = "https://generativelanguage.googleapis.com";

fn client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())
}

fn resolve_base(base_url: Option<&str>) -> String {
    base_url
        .map(|b| b.trim_end_matches('/'))
        .filter(|b| !b.is_empty())
        .unwrap_or(DEFAULT_BASE)
        .to_string()
}

pub async fn generate(
    api_key: &str,
    base_url: Option<&str>,
    opts: &GenOptions<'_>,
) -> Result<Vec<GeneratedImage>, String> {
    // Imagen uses `:predict`; the Gemini image models (Nano Banana) use
    // `:generateContent` with inline image parts.
    if opts.model.contains("imagen") {
        generate_imagen(api_key, base_url, opts).await
    } else {
        generate_gemini_image(api_key, base_url, opts).await
    }
}

/// Imagen `:predict` path.
async fn generate_imagen(
    api_key: &str,
    base_url: Option<&str>,
    opts: &GenOptions<'_>,
) -> Result<Vec<GeneratedImage>, String> {
    let base = resolve_base(base_url);
    let url = format!("{base}/v1beta/models/{}:predict?key={api_key}", opts.model);

    let client = client()?;

    let body = json!({
        "instances": [{ "prompt": opts.prompt }],
        "parameters": {
            "sampleCount": opts.n.max(1),
            "aspectRatio": aspect_ratio(opts.size),
        }
    });

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;
    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("gemini: bad response: {e}"))?;
    if !status.is_success() {
        let msg = payload
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("gemini: HTTP {status} — {msg}"));
    }

    let preds = payload
        .get("predictions")
        .and_then(|v| v.as_array())
        .ok_or("gemini: response had no `predictions`")?;
    let mut out = Vec::with_capacity(preds.len());
    for p in preds {
        let b64 = p
            .get("bytesBase64Encoded")
            .and_then(|v| v.as_str())
            .ok_or("gemini: prediction had no image bytes")?;
        let bytes = STANDARD
            .decode(b64)
            .map_err(|e| format!("gemini: bad base64: {e}"))?;
        let mime = p
            .get("mimeType")
            .and_then(|v| v.as_str())
            .unwrap_or("image/png")
            .to_string();
        out.push(GeneratedImage {
            bytes,
            mime,
            revised_prompt: None,
        });
    }
    if out.is_empty() {
        return Err("gemini: no images returned (prompt may have been blocked)".into());
    }
    Ok(out)
}

/// Gemini image models (Nano Banana) `:generateContent` path. The model returns
/// the image as an inline data part. One image per call, so we loop for `n`.
/// `responseModalities: [TEXT, IMAGE]` works for both the 2.5 image model and
/// the 2.0 preview. Aspect ratio isn't a documented knob here, so `size` is
/// advisory only (appended to the prompt as a hint).
async fn generate_gemini_image(
    api_key: &str,
    base_url: Option<&str>,
    opts: &GenOptions<'_>,
) -> Result<Vec<GeneratedImage>, String> {
    let base = resolve_base(base_url);
    let url = format!(
        "{base}/v1beta/models/{}:generateContent?key={api_key}",
        opts.model
    );
    let client = client()?;

    let prompt = format!(
        "{} (aspect ratio {})",
        opts.prompt,
        aspect_ratio(opts.size)
    );
    let body = json!({
        "contents": [{ "parts": [{ "text": prompt }] }],
        "generationConfig": { "responseModalities": ["TEXT", "IMAGE"] }
    });

    let mut out = Vec::with_capacity(opts.n.max(1) as usize);
    for _ in 0..opts.n.max(1) {
        let resp = client
            .post(&url)
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("gemini request failed: {e}"))?;
        let status = resp.status();
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| format!("gemini: bad response: {e}"))?;
        if !status.is_success() {
            let msg = payload
                .pointer("/error/message")
                .and_then(|v| v.as_str())
                .unwrap_or("unknown error");
            return Err(format!("gemini: HTTP {status} — {msg}"));
        }

        // Find the first part carrying inline image data.
        let part = payload
            .pointer("/candidates/0/content/parts")
            .and_then(|v| v.as_array())
            .and_then(|parts| parts.iter().find(|p| p.get("inlineData").is_some()))
            .and_then(|p| p.get("inlineData"))
            .ok_or("gemini: response had no inline image (prompt may have been blocked)")?;
        let b64 = part
            .get("data")
            .and_then(|v| v.as_str())
            .ok_or("gemini: inline image had no data")?;
        let bytes = STANDARD
            .decode(b64)
            .map_err(|e| format!("gemini: bad base64: {e}"))?;
        let mime = part
            .get("mimeType")
            .and_then(|v| v.as_str())
            .unwrap_or("image/png")
            .to_string();
        out.push(GeneratedImage {
            bytes,
            mime,
            revised_prompt: None,
        });
    }
    Ok(out)
}

/// `GET {base}/v1beta/models?key=…` → model ids, filtered to image-capable
/// models: Imagen (`:predict`) and Gemini image models like
/// `gemini-2.5-flash-image` ("Nano Banana"). Strips the `models/` prefix.
pub async fn list_models(api_key: &str, base_url: Option<&str>) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Err("Gemini API key not set".into());
    }
    let base = base_url
        .map(|b| b.trim_end_matches('/'))
        .filter(|b| !b.is_empty())
        .unwrap_or(DEFAULT_BASE);
    let resp = reqwest::Client::new()
        .get(format!("{base}/v1beta/models"))
        .query(&[("key", api_key), ("pageSize", "1000")])
        .send()
        .await
        .map_err(|e| format!("gemini request failed: {e}"))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("gemini: bad response: {e}"))?;
    if !status.is_success() {
        let msg = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown error");
        return Err(format!("gemini: HTTP {status} — {msg}"));
    }
    Ok(v.get("models")
        .and_then(|m| m.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|m| {
                    let supports_predict = m
                        .get("supportedGenerationMethods")
                        .and_then(|s| s.as_array())
                        .is_some_and(|a| a.iter().any(|x| x.as_str() == Some("predict")));
                    let name = m.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    // Imagen (`:predict`) + Gemini image models like
                    // `gemini-2.5-flash-image` ("Nano Banana", `:generateContent`).
                    supports_predict || name.contains("imagen") || name.contains("image")
                })
                .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                .map(|n| n.strip_prefix("models/").unwrap_or(n).to_string())
                .collect()
        })
        .unwrap_or_default())
}

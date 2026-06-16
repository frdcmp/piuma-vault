//! OpenAI Images API adapter (`gpt-image-1`, `dall-e-3`, …).
//! `POST {base}/v1/images/generations`. `gpt-image-1` returns `b64_json`;
//! `dall-e-*` may return a short-lived `url` — both are handled.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{json, Value};

use super::{GenOptions, GeneratedImage};

const DEFAULT_BASE: &str = "https://api.openai.com";

pub async fn generate(
    api_key: &str,
    base_url: Option<&str>,
    opts: &GenOptions<'_>,
) -> Result<Vec<GeneratedImage>, String> {
    let base = base_url
        .map(|b| b.trim_end_matches('/'))
        .filter(|b| !b.is_empty())
        .unwrap_or(DEFAULT_BASE);
    let url = format!("{base}/v1/images/generations");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // No `response_format` — gpt-image-1 rejects it (it always returns b64);
    // dall-e returns a url. We accept either below.
    let body = json!({
        "model": opts.model,
        "prompt": opts.prompt,
        "n": opts.n.max(1),
        "size": opts.size,
    });

    let resp = client
        .post(&url)
        .bearer_auth(api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;
    let status = resp.status();
    let payload: Value = resp
        .json()
        .await
        .map_err(|e| format!("openai: bad response: {e}"))?;
    if !status.is_success() {
        let msg = payload
            .pointer("/error/message")
            .and_then(|v| v.as_str())
            .unwrap_or("unknown error");
        return Err(format!("openai: HTTP {status} — {msg}"));
    }

    let data = payload
        .get("data")
        .and_then(|v| v.as_array())
        .ok_or("openai: response had no `data`")?;
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let revised_prompt = item
            .get("revised_prompt")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let bytes = if let Some(b64) = item.get("b64_json").and_then(|v| v.as_str()) {
            STANDARD
                .decode(b64)
                .map_err(|e| format!("openai: bad base64: {e}"))?
        } else if let Some(img_url) = item.get("url").and_then(|v| v.as_str()) {
            fetch_bytes(&client, img_url).await?
        } else {
            return Err("openai: image had neither b64_json nor url".into());
        };
        out.push(GeneratedImage {
            bytes,
            mime: "image/png".to_string(),
            revised_prompt,
        });
    }
    if out.is_empty() {
        return Err("openai: no images returned".into());
    }
    Ok(out)
}

/// `GET {base}/v1/models` → ids, filtered to image-generation models
/// (`gpt-image-*`, `dall-e-*`).
pub async fn list_models(api_key: &str, base_url: Option<&str>) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Err("OpenAI API key not set".into());
    }
    let base = base_url
        .map(|b| b.trim_end_matches('/'))
        .filter(|b| !b.is_empty())
        .unwrap_or(DEFAULT_BASE);
    let resp = reqwest::Client::new()
        .get(format!("{base}/v1/models"))
        .bearer_auth(api_key)
        .send()
        .await
        .map_err(|e| format!("openai request failed: {e}"))?;
    let status = resp.status();
    let v: Value = resp
        .json()
        .await
        .map_err(|e| format!("openai: bad response: {e}"))?;
    if !status.is_success() {
        let msg = v
            .pointer("/error/message")
            .and_then(|x| x.as_str())
            .unwrap_or("unknown error");
        return Err(format!("openai: HTTP {status} — {msg}"));
    }
    Ok(v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .filter(|id| id.contains("gpt-image") || id.contains("dall-e"))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default())
}

async fn fetch_bytes(client: &reqwest::Client, url: &str) -> Result<Vec<u8>, String> {
    let resp = client
        .get(url)
        .send()
        .await
        .map_err(|e| format!("openai: image download failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("openai: image download HTTP {}", resp.status()));
    }
    resp.bytes()
        .await
        .map(|b| b.to_vec())
        .map_err(|e| format!("openai: image read failed: {e}"))
}

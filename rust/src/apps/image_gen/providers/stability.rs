//! Stability AI adapter — `POST {base}/v2beta/stable-image/generate/core`
//! (multipart form). With `Accept: application/json` the response is
//! `{ image: <base64>, finish_reason }`. The `core` endpoint has no model id.

use std::time::Duration;

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::Value;

use super::{aspect_ratio, GenOptions, GeneratedImage};

const DEFAULT_BASE: &str = "https://api.stability.ai";

pub async fn generate(
    api_key: &str,
    base_url: Option<&str>,
    opts: &GenOptions<'_>,
) -> Result<Vec<GeneratedImage>, String> {
    let base = base_url
        .map(|b| b.trim_end_matches('/'))
        .filter(|b| !b.is_empty())
        .unwrap_or(DEFAULT_BASE);
    let url = format!("{base}/v2beta/stable-image/generate/core");

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .map_err(|e| e.to_string())?;

    // `core` returns a single image; loop to honour `n`.
    let mut out = Vec::with_capacity(opts.n.max(1) as usize);
    for _ in 0..opts.n.max(1) {
        let form = reqwest::multipart::Form::new()
            .text("prompt", opts.prompt.to_string())
            .text("output_format", "png")
            .text("aspect_ratio", aspect_ratio(opts.size).to_string());

        let resp = client
            .post(&url)
            .bearer_auth(api_key)
            .header("Accept", "application/json")
            .multipart(form)
            .send()
            .await
            .map_err(|e| format!("stability request failed: {e}"))?;
        let status = resp.status();
        let payload: Value = resp
            .json()
            .await
            .map_err(|e| format!("stability: bad response: {e}"))?;
        if !status.is_success() {
            let msg = payload
                .get("errors")
                .and_then(|v| v.as_array())
                .and_then(|a| a.first())
                .and_then(|v| v.as_str())
                .or_else(|| payload.get("message").and_then(|v| v.as_str()))
                .unwrap_or("unknown error");
            return Err(format!("stability: HTTP {status} — {msg}"));
        }
        let b64 = payload
            .get("image")
            .and_then(|v| v.as_str())
            .ok_or("stability: response had no `image`")?;
        let bytes = STANDARD
            .decode(b64)
            .map_err(|e| format!("stability: bad base64: {e}"))?;
        out.push(GeneratedImage {
            bytes,
            mime: "image/png".to_string(),
            revised_prompt: None,
        });
    }
    Ok(out)
}

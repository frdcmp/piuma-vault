//! Best-effort "list available models" for a configured provider. The admin UI
//! calls this so the wire-id field can suggest the models a key actually has
//! access to, instead of making the user type ids from memory.
//!
//! OpenAI-compatible kinds (deepseek/openai/minimax/…) hit `{base}/models` with
//! a bearer token; anthropic and gemini use their own shapes.

use serde_json::Value;

fn trim_base(base_url: Option<&str>, default: &str) -> String {
    base_url
        .filter(|s| !s.trim().is_empty())
        .unwrap_or(default)
        .trim_end_matches('/')
        .to_string()
}

/// Wire ids of the models this provider exposes for the given key, sorted.
pub async fn list_models(
    kind: &str,
    api_key: &str,
    base_url: Option<&str>,
) -> Result<Vec<String>, String> {
    if api_key.trim().is_empty() {
        return Err("provider has no API key set".into());
    }
    let client = reqwest::Client::new();
    let mut ids = match kind {
        "gemini" => {
            let base = trim_base(base_url, super::gemini::DEFAULT_BASE_URL);
            let url = format!("{base}/v1beta/models");
            let resp = client
                .get(&url)
                .query(&[("key", api_key)])
                .send()
                .await
                .map_err(|e| format!("{kind} request failed: {e}"))?;
            let v = read_json(resp, kind).await?;
            v.get("models")
                .and_then(|m| m.as_array())
                .map(|arr| {
                    arr.iter()
                        .filter_map(|m| m.get("name").and_then(|n| n.as_str()))
                        .map(|n| n.strip_prefix("models/").unwrap_or(n).to_string())
                        .collect()
                })
                .unwrap_or_default()
        }
        "anthropic" => {
            let base = trim_base(base_url, super::anthropic::DEFAULT_BASE_URL);
            let url = format!("{base}/v1/models");
            let resp = client
                .get(&url)
                .header("x-api-key", api_key)
                .header("anthropic-version", "2023-06-01")
                .send()
                .await
                .map_err(|e| format!("{kind} request failed: {e}"))?;
            let v = read_json(resp, kind).await?;
            openai_ids(&v)
        }
        // OpenAI-compatible wire format: deepseek/openai/minimax and friends.
        _ => {
            let default = match kind {
                "openai" => super::openai::DEFAULT_BASE_URL,
                "minimax" => super::minimax::DEFAULT_BASE_URL,
                _ => super::deepseek::DEFAULT_BASE_URL,
            };
            let base = trim_base(base_url, default);
            let url = format!("{base}/models");
            let resp = client
                .get(&url)
                .bearer_auth(api_key)
                .send()
                .await
                .map_err(|e| format!("{kind} request failed: {e}"))?;
            let v = read_json(resp, kind).await?;
            openai_ids(&v)
        }
    };
    ids.sort();
    ids.dedup();
    Ok(ids)
}

async fn read_json(resp: reqwest::Response, kind: &str) -> Result<Value, String> {
    if !resp.status().is_success() {
        let status = resp.status();
        let body = resp.text().await.unwrap_or_default();
        return Err(format!("{kind} HTTP {status}: {body}"));
    }
    resp.json()
        .await
        .map_err(|e| format!("{kind} decode failed: {e}"))
}

/// Pull `data[].id` from an OpenAI-style `{ "data": [...] }` listing.
fn openai_ids(v: &Value) -> Vec<String> {
    v.get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()))
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default()
}

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
    // Local OpenAI-compatible runtimes (LM Studio / Ollama) need no key, so we
    // only require one for the cloud providers.
    let is_local = matches!(kind, "lmstudio" | "ollama");
    if api_key.trim().is_empty() && !is_local {
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
        // OpenAI-compatible wire format: deepseek/openai/minimax + local runtimes
        // (lmstudio/ollama). Local kinds rely on the user-supplied base_url.
        _ => {
            let default = match kind {
                "openai" => super::openai::DEFAULT_BASE_URL,
                "minimax" => super::minimax::DEFAULT_BASE_URL,
                _ => super::deepseek::DEFAULT_BASE_URL,
            };
            let base = super::reach_host(&trim_base(base_url, default));
            let url = format!("{base}/models");
            let mut req = client.get(&url);
            // Local servers take no key; only attach a bearer when we have one.
            if !api_key.trim().is_empty() {
                req = req.bearer_auth(api_key);
            }
            let resp = req
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

/// Ollama-only: richer per-model metadata via the native `/api/show` endpoint
/// (context length + vision capability) that the OpenAI `/v1/models` id list
/// doesn't expose. Best-effort — returns `(None, false)` on any failure so the
/// UI just falls back to manual toggles. `base_url` includes `/v1`; the native
/// API lives at the server root, so we strip it.
pub async fn ollama_model_meta(base_url: Option<&str>, model: &str) -> (Option<i32>, bool) {
    let base = super::reach_host(&trim_base(base_url, "http://host.docker.internal:11434/v1"));
    let root = base.strip_suffix("/v1").unwrap_or(&base).trim_end_matches('/');
    let url = format!("{root}/api/show");

    let resp = match reqwest::Client::new()
        .post(&url)
        .json(&serde_json::json!({ "name": model }))
        .send()
        .await
    {
        Ok(r) if r.status().is_success() => r,
        _ => return (None, false),
    };
    let Ok(v) = resp.json::<Value>().await else {
        return (None, false);
    };

    // Vision: newer Ollama reports a `capabilities` array; older builds expose
    // it via `details.families` containing a vision projector (clip/mllama).
    let cap_vision = v
        .get("capabilities")
        .and_then(|c| c.as_array())
        .is_some_and(|a| a.iter().any(|x| x.as_str() == Some("vision")));
    let fam_vision = v
        .get("details")
        .and_then(|d| d.get("families"))
        .and_then(|f| f.as_array())
        .is_some_and(|a| {
            a.iter()
                .any(|x| matches!(x.as_str(), Some("clip") | Some("mllama")))
        });

    // Context length lives under `model_info` as `"<arch>.context_length"`.
    let ctx = v
        .get("model_info")
        .and_then(|m| m.as_object())
        .and_then(|m| {
            m.iter()
                .find(|(k, _)| k.ends_with(".context_length"))
                .and_then(|(_, val)| val.as_i64())
        })
        .map(|n| n as i32);

    (ctx, cap_vision || fam_vision)
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

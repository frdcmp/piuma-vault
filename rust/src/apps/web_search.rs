//! Provider-agnostic web search. A small adapter layer so the agent's
//! `web_search` tool (and the Services "test" button) work against whichever
//! backend is configured — Brave, Tavily, SerpAPI (Google), or Exa. The active
//! provider is the `websearch_provider` setting; each provider's key is its own
//! `websearch_<provider>_api_key` setting. Adding another provider = one more
//! arm here plus a key constant.

use std::time::Duration;

use serde_json::{json, Value};

use crate::apps::settings::store;
use crate::db::db::DbPool;

const DEFAULT_PROVIDER: &str = "brave";

/// Resolve the configured provider + key from settings and run a search.
/// Returns normalised hits: `[{ title, url, description }]`.
pub async fn search(pool: &DbPool, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let provider = store::get(pool, store::WEBSEARCH_PROVIDER)
        .await
        .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    let key = key_for(pool, &provider).await?;
    run(&provider, &key, query, limit).await
}

/// Run a search against an explicit provider + key (used by the "test" button,
/// before the admin has saved the value).
pub async fn run(provider: &str, key: &str, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let limit = limit.clamp(1, 10);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .build()
        .map_err(|e| e.to_string())?;
    match provider {
        "brave" => brave(&client, key, query, limit).await,
        "tavily" => tavily(&client, key, query, limit).await,
        "serpapi" => serpapi(&client, key, query, limit).await,
        "exa" => exa(&client, key, query, limit).await,
        other => Err(format!("unknown web search provider: {other}")),
    }
}

/// The configured provider's saved API key, or a helpful error.
pub async fn key_for(pool: &DbPool, provider: &str) -> Result<String, String> {
    let opt = match provider {
        "brave" => store::get(pool, store::WEBSEARCH_BRAVE_API_KEY).await,
        "tavily" => store::get(pool, store::WEBSEARCH_TAVILY_API_KEY).await,
        "serpapi" => store::get(pool, store::WEBSEARCH_SERPAPI_API_KEY).await,
        "exa" => store::get(pool, store::WEBSEARCH_EXA_API_KEY).await,
        other => return Err(format!("unknown web search provider: {other}")),
    };
    opt.ok_or_else(|| format!("{provider} API key not set — add it in admin → Services"))
}

fn hit(title: &str, url: &str, description: &str) -> Value {
    json!({ "title": title, "url": url, "description": description })
}

fn s(v: Option<&Value>, key: &str) -> String {
    v.and_then(|x| x.get(key)).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

async fn brave(client: &reqwest::Client, key: &str, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let count = limit.to_string();
    let resp = client
        .get("https://api.search.brave.com/res/v1/web/search")
        .query(&[("q", query), ("count", count.as_str())])
        .header("X-Subscription-Token", key)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("brave request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("brave: HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("brave: bad response: {e}"))?;
    let results = body.pointer("/web/results").and_then(|v| v.as_array());
    Ok(results
        .map(|arr| {
            arr.iter()
                .take(limit as usize)
                .map(|r| hit(&s(Some(r), "title"), &s(Some(r), "url"), &s(Some(r), "description")))
                .collect()
        })
        .unwrap_or_default())
}

async fn tavily(client: &reqwest::Client, key: &str, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let resp = client
        .post("https://api.tavily.com/search")
        .json(&json!({ "api_key": key, "query": query, "max_results": limit }))
        .send()
        .await
        .map_err(|e| format!("tavily request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("tavily: HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("tavily: bad response: {e}"))?;
    let results = body.get("results").and_then(|v| v.as_array());
    Ok(results
        .map(|arr| {
            arr.iter()
                .take(limit as usize)
                .map(|r| hit(&s(Some(r), "title"), &s(Some(r), "url"), &s(Some(r), "content")))
                .collect()
        })
        .unwrap_or_default())
}

async fn serpapi(client: &reqwest::Client, key: &str, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let num = limit.to_string();
    let resp = client
        .get("https://serpapi.com/search.json")
        .query(&[("engine", "google"), ("q", query), ("num", num.as_str()), ("api_key", key)])
        .send()
        .await
        .map_err(|e| format!("serpapi request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("serpapi: HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("serpapi: bad response: {e}"))?;
    let results = body.get("organic_results").and_then(|v| v.as_array());
    Ok(results
        .map(|arr| {
            arr.iter()
                .take(limit as usize)
                .map(|r| hit(&s(Some(r), "title"), &s(Some(r), "link"), &s(Some(r), "snippet")))
                .collect()
        })
        .unwrap_or_default())
}

async fn exa(client: &reqwest::Client, key: &str, query: &str, limit: i64) -> Result<Vec<Value>, String> {
    let resp = client
        .post("https://api.exa.ai/search")
        .header("x-api-key", key)
        .json(&json!({ "query": query, "numResults": limit }))
        .send()
        .await
        .map_err(|e| format!("exa request failed: {e}"))?;
    if !resp.status().is_success() {
        return Err(format!("exa: HTTP {}", resp.status()));
    }
    let body: Value = resp.json().await.map_err(|e| format!("exa: bad response: {e}"))?;
    let results = body.get("results").and_then(|v| v.as_array());
    Ok(results
        .map(|arr| {
            arr.iter()
                .take(limit as usize)
                // Exa returns title/url; a snippet only when `contents` is requested.
                .map(|r| hit(&s(Some(r), "title"), &s(Some(r), "url"), &s(Some(r), "text")))
                .collect()
        })
        .unwrap_or_default())
}

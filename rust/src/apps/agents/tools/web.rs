//! Web tools — provider-agnostic, run server-side. `web_search` delegates to the
//! configured provider (see `apps::web_search`). `web_fetch` reads a page through
//! the server's page reader (see `apps::web_page`): its title and text, and a
//! site's own fields where the reader knows the site.

use serde_json::{json, Value};

use super::*;
use crate::db::db::DbPool;

const MAX_TEXT: usize = 12_000; // cap chars returned to the model

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "web_search",
            "Search the web (Brave). Use for anything not in the vault or needing current info. Always say when an answer came from the web vs the vault.",
            json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "description": "max results (default 5, max 10)" }
                },
                "required": ["query"]
            }),
        ),
        (
            "web_fetch",
            "Read a web page by URL: its title and its text (redirects are followed). A job posting on LinkedIn or JobsDB also comes with its fields as `data` (company, location, salary, employment type, dates), and its text is the posting.",
            json!({
                "type": "object",
                "properties": { "url": { "type": "string", "description": "http(s) URL" } },
                "required": ["url"]
            }),
        ),
    ]
}

pub async fn web_search(pool: &DbPool, args: &Value) -> Result<Value, String> {
    let query = req_str(args, "query")?;
    let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(5);
    // Provider + key resolve from settings (admin → Services → Web Search).
    let results = crate::apps::web_search::search(pool, &query, limit).await?;
    Ok(json!({ "count": results.len(), "results": results }))
}

pub async fn web_fetch(args: &Value) -> Result<Value, String> {
    let page = crate::apps::web_page::read(&req_str(args, "url")?).await?;
    let content: String = page.text.chars().take(MAX_TEXT).collect();
    let truncated = content.len() < page.text.len();
    let mut out = json!({ "url": page.url, "status": page.status, "title": page.title, "truncated": truncated, "content": content });
    if let Some(site) = page.site {
        out["site"] = json!(site);
        out["data"] = page.data.clone();
    }
    Ok(out)
}

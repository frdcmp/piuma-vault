//! Web tools — provider-agnostic, run server-side. `web_search` delegates to the
//! configured provider (see `apps::web_search`). `web_fetch` GETs a URL and
//! returns cleaned text, behind an SSRF guard (no private/loopback/link-local/
//! metadata addresses; redirects are not followed).

use std::net::IpAddr;
use std::time::Duration;

use serde_json::{json, Value};

use super::*;
use crate::db::db::DbPool;

const MAX_BODY: usize = 60_000; // cap bytes read from a fetched page
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
            "Fetch a web page by URL and return its cleaned text content.",
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
    let raw = req_str(args, "url")?;
    let url = reqwest::Url::parse(&raw).map_err(|_| "invalid URL".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) URLs are allowed".into());
    }
    let host = url.host_str().ok_or("URL has no host")?.to_string();
    let port = url.port_or_known_default().unwrap_or(80);

    // SSRF guard: resolve the host and reject any non-public address.
    let addrs = tokio::net::lookup_host((host.as_str(), port))
        .await
        .map_err(|e| format!("could not resolve host: {e}"))?;
    let mut any = false;
    for addr in addrs {
        any = true;
        if is_blocked_ip(addr.ip()) {
            return Err("refusing to fetch a private/loopback/link-local address".into());
        }
    }
    if !any {
        return Err("host did not resolve".into());
    }

    // No redirect following — a 3xx to an internal host would bypass the guard.
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(12))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client
        .get(url.clone())
        .header("User-Agent", "PiumaVault/1.0 (+agent web_fetch)")
        .send()
        .await
        .map_err(|e| format!("fetch failed: {e}"))?;
    let status = resp.status();
    if status.is_redirection() {
        let location = resp
            .headers()
            .get("location")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");
        return Ok(json!({ "url": raw, "status": status.as_u16(), "redirected_to": location, "note": "redirects are not followed; re-fetch the target URL if it's safe" }));
    }
    if !status.is_success() {
        return Err(format!("fetch failed: HTTP {status}"));
    }
    let content_type = resp
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_lowercase();
    let bytes = resp.bytes().await.map_err(|e| e.to_string())?;
    let slice = &bytes[..bytes.len().min(MAX_BODY)];
    let raw_text = String::from_utf8_lossy(slice).to_string();

    let text = if content_type.contains("text/html") || raw_text.trim_start().starts_with('<') {
        html_to_text(&raw_text)
    } else if content_type.starts_with("text/")
        || content_type.contains("json")
        || content_type.contains("xml")
        || content_type.is_empty()
    {
        raw_text
    } else {
        return Err(format!("unsupported content-type: {content_type}"));
    };
    let truncated = text.len() > MAX_TEXT;
    let mut text = text;
    if truncated {
        text.truncate(MAX_TEXT);
    }
    Ok(json!({ "url": raw, "status": status.as_u16(), "truncated": truncated, "content": text }))
}

fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            v4.is_loopback()
                || v4.is_private()
                || v4.is_link_local()
                || v4.is_broadcast()
                || v4.is_unspecified()
                || v4.is_documentation()
                || v4.octets()[0] == 0
                // CGNAT 100.64.0.0/10
                || (v4.octets()[0] == 100 && (v4.octets()[1] & 0xc0) == 64)
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            let seg = v6.segments();
            v6.is_loopback()
                || v6.is_unspecified()
                // unique-local fc00::/7
                || (seg[0] & 0xfe00) == 0xfc00
                // link-local fe80::/10
                || (seg[0] & 0xffc0) == 0xfe80
        }
    }
}

// Crude HTML → text: drop script/style, strip tags, decode a few entities,
// collapse whitespace. Good enough to feed a page's gist to the model.
fn html_to_text(html: &str) -> String {
    let bytes = html.as_bytes();
    // ASCII-only lowercasing keeps byte positions (and char boundaries) identical
    // to `html`, and tag names we match (`<script`/`<style`) are ASCII anyway.
    // Match on byte slices so a multibyte char in the page can never land us on a
    // non-char-boundary index and panic.
    let lower = html.to_ascii_lowercase();
    let lbytes = lower.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(html.len());
    let mut i = 0;
    let mut in_tag = false;
    let mut skip_until: Option<&[u8]> = None;

    while i < bytes.len() {
        if let Some(close) = skip_until {
            if lbytes[i..].starts_with(close) {
                i += close.len();
                skip_until = None;
            } else {
                i += 1;
            }
            continue;
        }
        if lbytes[i..].starts_with(b"<script") {
            skip_until = Some(b"</script>");
            i += 7;
            continue;
        }
        if lbytes[i..].starts_with(b"<style") {
            skip_until = Some(b"</style>");
            i += 6;
            continue;
        }
        let b = bytes[i];
        if b == b'<' {
            in_tag = true;
        } else if b == b'>' {
            in_tag = false;
            out.push(b' ');
        } else if !in_tag {
            // Only ASCII tag delimiters are dropped, so multibyte sequences
            // always survive intact — decode the kept bytes as UTF-8 at the end.
            out.push(b);
        }
        i += 1;
    }

    let out = String::from_utf8_lossy(&out);
    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    decoded.split_whitespace().collect::<Vec<_>>().join(" ")
}

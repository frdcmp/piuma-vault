//! Reading a web page, for anything on the server that needs one (the agent's `web_fetch`
//! is the first). `read` GETs an address behind the SSRF guard, every redirect hop
//! checked, and gives the page's title and text. A site with a reader in `sites` (a job
//! posting on LinkedIn or JobsDB) is read from its own data: its fields come as `data`,
//! and the text is the posting itself, not the whole page.
//!
//! A page read is kept for a few minutes, and a host is asked at most once a second.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use moka::future::Cache;
use reqwest::Url;
use scraper::Html;
use serde::Serialize;
use serde_json::Value;
use tokio::time::Instant;

mod html;
mod sites;

const MAX_BODY: usize = 3_000_000; // bytes read of a page
const MAX_HOPS: usize = 5; // redirects followed
const TIMEOUT: Duration = Duration::from_secs(15);
const KEPT_FOR: Duration = Duration::from_secs(600);
const HOST_GAP: Duration = Duration::from_secs(1);
const USER_AGENT: &str = "PiumaVault/1.0 (+page reader)";

#[derive(Debug, Clone, Serialize)]
pub struct Page {
    /// The page's address: where the redirects ended, or its site's own short form.
    pub url: String,
    pub status: u16,
    /// The reader that made `data`, when the site has one.
    pub site: Option<&'static str>,
    pub title: Option<String>,
    pub text: String,
    /// What the site's reader found (see `sites`); null for any other page.
    pub data: Value,
}

/// The page at an address, from the last few minutes' reads when it's there.
pub async fn read(raw: &str) -> Result<Arc<Page>, String> {
    static PAGES: OnceLock<Cache<String, Arc<Page>>> = OnceLock::new();
    let pages = PAGES.get_or_init(|| Cache::builder().max_capacity(100).time_to_live(KEPT_FOR).build());
    if let Some(page) = pages.get(raw).await {
        return Ok(page);
    }
    let page = Arc::new(fetch(raw).await?);
    pages.insert(raw.to_string(), page.clone()).await;
    Ok(page)
}

async fn fetch(raw: &str) -> Result<Page, String> {
    let mut url = Url::parse(raw).map_err(|_| "invalid URL".to_string())?;
    // Redirects are followed here, one hop at a time: each address passes the guard first.
    let client = reqwest::Client::builder()
        .timeout(TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut site: Option<(&'static sites::Site, String)> = None;
    for _ in 0..=MAX_HOPS {
        if site.is_none() {
            if let Some((s, at)) = sites::find(&url) {
                site = Some((s, at.shown));
                url = at.fetch;
            }
        }
        guard_public_url(&url).await?;
        wait_turn(&url).await;
        let mut resp = client
            .get(url.clone())
            .header(reqwest::header::USER_AGENT, USER_AGENT)
            .send()
            .await
            .map_err(|e| format!("fetch failed: {e}"))?;
        let status = resp.status();
        if status.is_redirection() {
            let to = resp.headers().get(reqwest::header::LOCATION).and_then(|v| v.to_str().ok()).ok_or("a redirect with no address")?;
            url = url.join(to).map_err(|_| "a redirect to an invalid URL".to_string())?;
            continue;
        }
        if !status.is_success() {
            return Err(format!("fetch failed: HTTP {status}"));
        }
        let content_type = resp.headers().get(reqwest::header::CONTENT_TYPE).and_then(|v| v.to_str().ok()).unwrap_or("").to_lowercase();
        let is_html = content_type.contains("html");
        if !(is_html || content_type.is_empty() || content_type.starts_with("text/") || content_type.contains("json") || content_type.contains("xml")) {
            return Err(format!("unsupported content-type: {content_type}"));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = resp.chunk().await.map_err(|e| e.to_string())? {
            let room = MAX_BODY - bytes.len();
            bytes.extend_from_slice(&chunk[..chunk.len().min(room)]);
            if bytes.len() == MAX_BODY {
                break;
            }
        }
        let body = String::from_utf8_lossy(&bytes).into_owned();
        let is_html = is_html || (content_type.is_empty() && body.trim_start().starts_with('<'));
        return page(url, status.as_u16(), site, is_html, body);
    }
    Err("too many redirects".into())
}

fn page(url: Url, status: u16, site: Option<(&'static sites::Site, String)>, is_html: bool, body: String) -> Result<Page, String> {
    if let Some((s, shown)) = site {
        let found = (s.read)(&Html::parse_document(&body), &body).ok_or_else(|| format!("{}: the page doesn't show what its reader looks for", s.name))?;
        return Ok(Page { url: shown, status, site: Some(s.name), title: found.title, text: found.text, data: found.data });
    }
    let (title, text) = if is_html {
        let doc = Html::parse_document(&body);
        (html::title(&doc), html::page_text(&doc))
    } else {
        (None, body)
    };
    Ok(Page { url: url.into(), status, site: None, title, text, data: Value::Null })
}

/// A host is asked at most once every `HOST_GAP`: each request books the host's next free moment.
async fn wait_turn(url: &Url) {
    static NEXT: OnceLock<Mutex<HashMap<String, Instant>>> = OnceLock::new();
    let at = {
        let mut next = NEXT.get_or_init(Default::default).lock().unwrap_or_else(|e| e.into_inner());
        let now = Instant::now();
        next.retain(|_, free| *free > now);
        let host = url.host_str().unwrap_or_default().to_string();
        let at = next.get(&host).copied().unwrap_or(now);
        next.insert(host, at + HOST_GAP);
        at
    };
    tokio::time::sleep_until(at).await;
}

/// SSRF guard, shared by the server's fetchers (this reader, image inlining).
/// Rejects non-http(s) schemes and resolves the host, failing if *any* resolved
/// address is private/loopback/link-local/metadata. Callers MUST also disable
/// redirect following so a 3xx can't bounce to an internal host after this check.
pub(crate) async fn guard_public_url(url: &Url) -> Result<(), String> {
    if !matches!(url.scheme(), "http" | "https") {
        return Err("only http(s) URLs are allowed".into());
    }
    let host = url.host_str().ok_or("URL has no host")?.to_string();
    let port = url.port_or_known_default().unwrap_or(80);
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
    Ok(())
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inside_addresses_are_refused() {
        for ip in ["127.0.0.1", "10.1.2.3", "192.168.1.1", "169.254.169.254", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"] {
            assert!(is_blocked_ip(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["93.184.216.34", "2606:2800:220:1::1"] {
            assert!(!is_blocked_ip(ip.parse().unwrap()), "{ip}");
        }
    }

    #[tokio::test]
    async fn a_host_is_asked_once_in_a_while() {
        let host = Url::parse("https://turns.example/a").unwrap();
        let start = Instant::now();
        wait_turn(&host).await;
        wait_turn(&Url::parse("https://other.example/").unwrap()).await;
        assert!(start.elapsed() < HOST_GAP);
        wait_turn(&host).await;
        assert!(start.elapsed() >= HOST_GAP);
    }

    #[test]
    fn a_page_with_no_reader_gives_its_title_and_text() {
        let body = "<html><head><title> A page </title><style>p{}</style></head><body><nav>Menu</nav><main><h1>Hello</h1><p>One &amp; two</p></main></body></html>";
        let p = page(Url::parse("https://example.com/a").unwrap(), 200, None, true, body.into()).unwrap();
        assert_eq!((p.title.as_deref(), p.text.as_str(), p.site), (Some("A page"), "Hello\nOne & two", None));
        assert!(p.data.is_null());
        let p = page(Url::parse("https://example.com/a.json").unwrap(), 200, None, false, "{\"a\":1}".into()).unwrap();
        assert_eq!((p.title, p.text.as_str()), (None, "{\"a\":1}"));
    }

    #[test]
    fn a_site_page_its_reader_cant_read_is_an_error() {
        let (site, at) = sites::find(&Url::parse("https://th.jobsdb.com/th/job/123?x=1").unwrap()).unwrap();
        let err = page(at.fetch, 200, Some((site, at.shown)), true, "<html><body>Sign in</body></html>".into()).unwrap_err();
        assert!(err.starts_with("jobsdb:"), "{err}");
    }

    /// Read a real page: `WEB_PAGE_URL=https://… cargo test --lib web_page::tests::live -- --ignored --nocapture`.
    #[tokio::test]
    #[ignore]
    async fn live() {
        let url = std::env::var("WEB_PAGE_URL").expect("WEB_PAGE_URL");
        let page = read(&url).await.unwrap();
        let text: String = page.text.chars().take(1500).collect();
        println!("url: {}\nstatus: {}\nsite: {:?}\ntitle: {:?}\ndata: {:#}\ntext ({} chars): {text}", page.url, page.status, page.site, page.title, page.data, page.text.chars().count());
    }
}

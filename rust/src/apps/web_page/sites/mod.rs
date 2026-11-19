//! Readers for sites whose pages are better read from their own data than from their text.
//! A reader says which of the site's addresses it reads and what to fetch for one (`at`),
//! and reads the page fetched (`read`).
//!
//! A job posting comes as `data` with `kind: "job"` and whichever of these its page gives:
//! `title`, `company`, `location`, `employment_type`, `workplace` (on-site, hybrid, remote),
//! `seniority`, `category`, `salary`, `posted` (the site's words: "2 days ago"),
//! `posted_at` and `closes_at` (UTC), `applicants`, `open`, `summary`, `highlights`, and
//! `questions` (what the application asks). The posting's description is the page's text.

use reqwest::Url;
use scraper::Html;
use serde_json::{json, Map, Value};

mod jobsdb;
mod linkedin;

pub struct Site {
    pub name: &'static str,
    /// When this address is one the reader reads: what to fetch for it.
    pub at: fn(&Url) -> Option<At>,
    /// The page fetched, parsed and as it came; none when it isn't what the reader looks for.
    pub read: fn(&Html, &str) -> Option<Found>,
}

pub struct At {
    /// The address to GET: the lightest page that carries the data.
    pub fetch: Url,
    /// The address to show a person.
    pub shown: String,
}

pub struct Found {
    pub title: Option<String>,
    pub text: String,
    pub data: Value,
}

static SITES: &[Site] = &[linkedin::SITE, jobsdb::SITE];

pub fn find(url: &Url) -> Option<(&'static Site, At)> {
    SITES.iter().find_map(|s| (s.at)(url).map(|at| (s, at)))
}

/// Whether `url` is on `domain` or one of its subdomains.
fn on(url: &Url, domain: &str) -> bool {
    url.host_str().is_some_and(|h| h == domain || h.strip_suffix(domain).is_some_and(|sub| sub.ends_with('.')))
}

/// A job posting's `data`: only the fields that have a value.
fn job(fields: Vec<(&str, Value)>) -> Value {
    let mut data = Map::new();
    data.insert("kind".into(), json!("job"));
    for (key, value) in fields {
        let empty = match &value {
            Value::Null => true,
            Value::String(s) => s.is_empty(),
            Value::Array(a) => a.is_empty(),
            _ => false,
        };
        if !empty {
            data.insert(key.into(), value);
        }
    }
    Value::Object(data)
}

//! A JobsDB job posting, read from the data its page carries for the site's own app.

use reqwest::Url;
use scraper::Html;
use serde_json::{json, Value};

use super::{job, on, At, Found, Site};
use crate::apps::web_page::html;

pub const SITE: Site = Site { name: "jobsdb", at, read };

/// `/job/<id>`, also under a language (`/th/job/<id>`): read without one, in the site's English.
fn at(url: &Url) -> Option<At> {
    if !on(url, "jobsdb.com") {
        return None;
    }
    let parts: Vec<&str> = url.path_segments()?.collect();
    let id = parts.get(parts.iter().position(|p| *p == "job")? + 1).filter(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))?;
    let page = format!("https://{}/job/{id}", url.host_str()?);
    Some(At { fetch: Url::parse(&page).ok()?, shown: page })
}

fn read(_doc: &Html, body: &str) -> Option<Found> {
    let marker = "window.SEEK_REDUX_DATA = ";
    let state = serde_json::Deserializer::from_str(&body[body.find(marker)? + marker.len()..]).into_iter::<Value>().next()?.ok()?;
    let result = state.pointer("/jobdetails/result")?;
    let posting = result.get("job").filter(|j| j.is_object())?;
    let text_at = |from: &Value, path: &str| from.pointer(path).and_then(Value::as_str).map(str::trim).map(String::from);
    let labels = |from: &Value, path: &str| -> String {
        let all: Vec<&str> = from.pointer(path).and_then(Value::as_array).into_iter().flatten().filter_map(|v| v.get("label")?.as_str()).collect();
        all.join(", ")
    };
    let title = text_at(posting, "/title")?;
    let open = posting.get("status").and_then(Value::as_str).map(|s| s == "Active" && posting.get("isExpired") != Some(&json!(true)));
    let data = job(vec![
        ("title", json!(title)),
        ("company", json!(text_at(posting, "/advertiser/name"))),
        ("location", json!(text_at(posting, "/location/label"))),
        ("employment_type", json!(text_at(posting, "/workTypes/label"))),
        ("workplace", json!(labels(result, "/workArrangements/arrangements"))),
        ("category", json!(labels(posting, "/classifications"))),
        ("salary", json!(text_at(posting, "/salary/label"))),
        ("posted", json!(text_at(posting, "/listedAt/label"))),
        ("posted_at", json!(text_at(posting, "/listedAt/dateTimeUtc"))),
        ("closes_at", json!(text_at(posting, "/expiresAt/dateTimeUtc"))),
        ("open", json!(open)),
        ("summary", json!(text_at(posting, "/abstract"))),
        ("highlights", posting.pointer("/products/bullets").cloned().unwrap_or_default()),
        ("questions", posting.pointer("/products/questionnaire/questions").cloned().unwrap_or_default()),
    ]);
    Some(Found { title: Some(title), text: html::fragment_text(posting.get("content")?.as_str()?), data })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_(url: &str) -> Option<String> {
        at(&Url::parse(url).unwrap()).map(|a| a.shown)
    }

    #[test]
    fn a_job_address_with_or_without_a_language() {
        let want = Some("https://th.jobsdb.com/job/90000001".to_string());
        assert_eq!(at_("https://th.jobsdb.com/job/90000001"), want);
        assert_eq!(at_("https://th.jobsdb.com/th/job/90000001?token=abc&tracking=x"), want);
        assert_eq!(at_("https://th.jobsdb.com/th/jobs/in-bangkok"), None);
        assert_eq!(at_("https://th.jobsdb.com/job/apply"), None);
        // the tracking links in its emails are read where they redirect to
        assert_eq!(at_("https://url.jobsdb.com/ss/c/u001.abc/4vt/def/h001.ghi"), None);
        assert_eq!(at_("https://example.com/job/90000001"), None);
    }

    #[test]
    fn a_posting_is_read_from_the_page_s_data() {
        let state = json!({ "jobdetails": { "result": {
            "workArrangements": { "arrangements": [{ "type": "HYBRID", "label": "Hybrid" }] },
            "job": {
                "title": "Data Engineer", "status": "Active", "isExpired": false, "abstract": "Pipelines for a retail group",
                "advertiser": { "name": "Acme Ltd" }, "location": { "label": "Bangkok" }, "workTypes": { "label": "Full time" },
                "classifications": [{ "label": "Developers/Programmers (Information & Communication Technology)" }],
                "salary": { "label": "฿80,000 – ฿100,000 per month" },
                "listedAt": { "label": "2d ago", "dateTimeUtc": "2026-01-10T02:00:00.000Z" }, "expiresAt": { "dateTimeUtc": "2026-02-09T12:59:59.999Z" },
                "products": { "bullets": ["Python", "SQL"], "questionnaire": { "questions": ["What's your expected monthly basic salary?"] } },
                "content": "<p><strong>About the role</strong></p><ul><li><p>Build pipelines</p></li></ul>"
            } } } });
        let body = format!("<html><body><script>window.SEEK_CONFIG = {{}};\nwindow.SEEK_REDUX_DATA = {state};\nwindow.SEEK_APP_CONFIG = {{}};</script></body></html>");
        let found = read(&Html::parse_document(&body), &body).unwrap();
        assert_eq!(found.title.as_deref(), Some("Data Engineer"));
        assert_eq!(found.text, "About the role\n- Build pipelines");
        assert_eq!(
            found.data,
            json!({ "kind": "job", "title": "Data Engineer", "company": "Acme Ltd", "location": "Bangkok", "employment_type": "Full time", "workplace": "Hybrid",
                "category": "Developers/Programmers (Information & Communication Technology)", "salary": "฿80,000 – ฿100,000 per month", "posted": "2d ago",
                "posted_at": "2026-01-10T02:00:00.000Z", "closes_at": "2026-02-09T12:59:59.999Z", "open": true, "summary": "Pipelines for a retail group",
                "highlights": ["Python", "SQL"], "questions": ["What's your expected monthly basic salary?"] })
        );
        // a page with no posting in it (expired, removed): nothing to read
        let gone = "<script>window.SEEK_REDUX_DATA = {\"jobdetails\":{\"result\":null}};</script>";
        assert!(read(&Html::parse_document(gone), gone).is_none());
    }
}

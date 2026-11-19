//! A LinkedIn job posting, read from the page LinkedIn serves to guests (no sign-in).

use reqwest::Url;
use scraper::{Html, Selector};
use serde_json::json;

use super::{job, on, At, Found, Site};
use crate::apps::web_page::html;

pub const SITE: Site = Site { name: "linkedin", at, read };

/// `/jobs/view/<id>`, also behind `/comm` (the links in LinkedIn's emails) and as `/jobs/view/<words>-<id>`.
fn at(url: &Url) -> Option<At> {
    if !on(url, "linkedin.com") {
        return None;
    }
    let parts: Vec<&str> = url.path_segments()?.collect();
    let view = parts.windows(2).position(|w| w == ["jobs", "view"])?;
    let last = parts.get(view + 2)?;
    let id = &last[last.trim_end_matches(|c: char| c.is_ascii_digit()).len()..];
    if id.is_empty() {
        return None;
    }
    Some(At {
        fetch: Url::parse(&format!("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{id}")).ok()?,
        shown: format!("https://www.linkedin.com/jobs/view/{id}"),
    })
}

fn read(doc: &Html, _body: &str) -> Option<Found> {
    let title = html::first(doc, ".top-card-layout__title")?;
    let description = doc.select(&Selector::parse(".show-more-less-html__markup").ok()?).next()?;
    // "Seniority level", "Employment type", "Job function", "Industries": each a heading and its value
    let item = Selector::parse(".description__job-criteria-item").ok()?;
    let criteria: Vec<(String, String)> = doc
        .select(&item)
        .filter_map(|li| {
            let part = |css: &str| li.select(&Selector::parse(css).ok()?).next().map(|e| html::one_line(&e.text().collect::<String>()));
            Some((part(".description__job-criteria-subheader")?, part(".description__job-criteria-text")?))
        })
        .collect();
    let criterion = |name: &str| criteria.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone());
    let data = job(vec![
        ("title", json!(title)),
        ("company", json!(html::first(doc, ".topcard__org-name-link"))),
        ("location", json!(html::first(doc, ".topcard__flavor--bullet"))),
        ("employment_type", json!(criterion("Employment type"))),
        ("seniority", json!(criterion("Seniority level"))),
        ("category", json!(criterion("Industries"))),
        ("salary", json!(html::first(doc, ".compensation__salary"))),
        ("posted", json!(html::first(doc, ".posted-time-ago__text"))),
        ("applicants", json!(html::first(doc, ".num-applicants__caption"))),
    ]);
    Some(Found { title: Some(title), text: html::text(description), data })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn at_(url: &str) -> Option<(String, String)> {
        at(&Url::parse(url).unwrap()).map(|a| (a.fetch.to_string(), a.shown))
    }

    #[test]
    fn a_job_address_in_any_of_its_forms() {
        let want = Some(("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4000000001".to_string(), "https://www.linkedin.com/jobs/view/4000000001".to_string()));
        assert_eq!(at_("https://www.linkedin.com/jobs/view/4000000001"), want);
        assert_eq!(at_("https://www.linkedin.com/comm/jobs/view/4000000001/?trackingId=abc&refId=x"), want);
        assert_eq!(at_("https://th.linkedin.com/jobs/view/data-engineer-at-acme-4000000001?trk=x"), want);
        assert_eq!(at_("https://www.linkedin.com/jobs/view/"), None);
        assert_eq!(at_("https://www.linkedin.com/in/someone"), None);
        assert_eq!(at_("https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/4000000001"), None);
        assert_eq!(at_("https://notlinkedin.com/jobs/view/4000000001"), None);
    }

    #[test]
    fn a_posting_is_read_from_the_guest_page() {
        let body = r#"<html><body>
            <h2 class="top-card-layout__title topcard__title">Data Engineer</h2>
            <a class="topcard__org-name-link" href="x"> Acme Ltd </a>
            <span class="topcard__flavor topcard__flavor--bullet"> Bangkok, Thailand </span>
            <span class="posted-time-ago__text"> 2 days ago </span>
            <figure class="topcard__flavor--bullet"><figcaption class="num-applicants__caption"> 40 applicants </figcaption></figure>
            <div class="show-more-less-html__markup"><p><strong>About</strong></p><p>Build pipelines.</p><ul><li>Python</li><li>SQL</li></ul></div>
            <ul><li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader"> Seniority level </h3><span class="description__job-criteria-text"> Associate </span></li>
            <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader"> Employment type </h3><span class="description__job-criteria-text"> Full-time </span></li>
            <li class="description__job-criteria-item"><h3 class="description__job-criteria-subheader"> Industries </h3><span class="description__job-criteria-text"> Software Development </span></li></ul>
            </body></html>"#;
        let found = read(&Html::parse_document(body), body).unwrap();
        assert_eq!(found.title.as_deref(), Some("Data Engineer"));
        assert_eq!(found.text, "About\nBuild pipelines.\n- Python\n- SQL");
        assert_eq!(
            found.data,
            json!({ "kind": "job", "title": "Data Engineer", "company": "Acme Ltd", "location": "Bangkok, Thailand", "employment_type": "Full-time",
                "seniority": "Associate", "category": "Software Development", "posted": "2 days ago", "applicants": "40 applicants" })
        );
        assert!(read(&Html::parse_document("<html><body>Sign in</body></html>"), "").is_none());
    }
}

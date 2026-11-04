//! Gmail messages in (the API's `format=full` JSON → what an item needs) and replies out (an
//! RFC 5322 message, base64url, for `messages.send`).

use base64::engine::general_purpose::{STANDARD, URL_SAFE, URL_SAFE_NO_PAD};
use base64::Engine;
use serde_json::Value as Json;

#[derive(Debug, Clone, Default)]
pub struct Parsed {
    pub id: String,
    pub thread_id: String,
    pub labels: Vec<String>,
    pub from: Option<(String, Option<String>)>,
    pub reply_to: Option<(String, Option<String>)>,
    pub to: Vec<(String, Option<String>)>,
    pub cc: Vec<(String, Option<String>)>,
    pub subject: Option<String>,
    pub message_id: Option<String>,
    pub references: Option<String>,
    /// milliseconds since the epoch (Gmail's internalDate)
    pub internal_date: i64,
    pub body: String,
    pub attachments: Vec<Attachment>,
}

/// A file attached to an email (its bytes are fetched apart, by `id`).
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Attachment {
    pub id: String,
    pub name: String,
    pub mime: String,
    pub size: u64,
}

/// An email's attached files: every part with a file name whose data Gmail keeps apart.
pub fn attachments(p: &Json) -> Vec<Attachment> {
    let mut out = Vec::new();
    let name = p["filename"].as_str().unwrap_or_default().trim();
    if let (false, Some(id)) = (name.is_empty(), p["body"]["attachmentId"].as_str()) {
        out.push(Attachment {
            id: id.to_string(),
            name: name.to_string(),
            mime: p["mimeType"].as_str().unwrap_or("application/octet-stream").to_string(),
            size: p["body"]["size"].as_u64().unwrap_or(0),
        });
    }
    for part in p["parts"].as_array().into_iter().flatten() {
        out.extend(attachments(part));
    }
    out
}

pub fn parse(msg: &Json) -> Parsed {
    let payload = &msg["payload"];
    let h = |name: &str| header(payload, name);
    Parsed {
        id: msg["id"].as_str().unwrap_or_default().to_string(),
        thread_id: msg["threadId"].as_str().unwrap_or_default().to_string(),
        labels: msg["labelIds"].as_array().into_iter().flatten().filter_map(|l| l.as_str().map(String::from)).collect(),
        from: h("From").map(|v| address(&v)),
        reply_to: h("Reply-To").map(|v| address(&v)),
        to: h("To").map(|v| addresses(&v)).unwrap_or_default(),
        cc: h("Cc").map(|v| addresses(&v)).unwrap_or_default(),
        subject: h("Subject"),
        message_id: h("Message-ID").or_else(|| h("Message-Id")),
        references: h("References"),
        internal_date: msg["internalDate"].as_str().and_then(|s| s.parse().ok()).unwrap_or(0),
        // a forward is the message it carries: kept whole (Outlook puts it under the same line
        // as a quoted reply)
        body: if is_forward(h("Subject").as_deref()) { body(payload).trim().to_string() } else { strip_quoted(&body(payload)) },
        attachments: attachments(payload),
    }
}

/// A subject that says the email forwards another (Fw:, Fwd:, and Outlook's in other languages:
/// I: Italian, RV: Spanish, WG: German, TR: French, ENC: Portuguese).
fn is_forward(subject: Option<&str>) -> bool {
    let s = subject.unwrap_or_default().trim_start().to_lowercase();
    ["fw:", "fwd:", "i:", "inoltra:", "rv:", "wg:", "tr:", "enc:"].iter().any(|p| s.starts_with(p))
}

fn header(payload: &Json, name: &str) -> Option<String> {
    payload["headers"]
        .as_array()?
        .iter()
        .find(|h| h["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(name)))
        .and_then(|h| h["value"].as_str())
        .map(str::to_string)
}

/// `"Marco Rossi" <marco@example.com>` or `marco@example.com` → (address, name).
pub fn address(s: &str) -> (String, Option<String>) {
    let s = s.trim();
    if let (Some(lt), Some(gt)) = (s.rfind('<'), s.rfind('>')) {
        if lt < gt {
            let addr = s[lt + 1..gt].trim().to_lowercase();
            let name = s[..lt].trim().trim_matches('"').trim();
            return (addr, (!name.is_empty()).then(|| name.to_string()));
        }
    }
    (s.trim_matches(|c| c == '<' || c == '>').to_lowercase(), None)
}

/// A header with several addresses, split on commas outside quotes.
pub fn addresses(s: &str) -> Vec<(String, Option<String>)> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    for c in s.chars() {
        match c {
            '"' => {
                quoted = !quoted;
                cur.push(c);
            }
            ',' if !quoted => {
                if !cur.trim().is_empty() {
                    out.push(address(&cur));
                }
                cur.clear();
            }
            _ => cur.push(c),
        }
    }
    if !cur.trim().is_empty() {
        out.push(address(&cur));
    }
    out
}

fn decode(data: &str) -> Option<String> {
    let bytes = URL_SAFE.decode(data).or_else(|_| URL_SAFE_NO_PAD.decode(data)).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// A message's first non-blank part of this type, decoded (a blank part doesn't count: some
/// senders put an empty text/plain beside the real HTML).
fn find(p: &Json, mime: &str) -> Option<String> {
    if p["mimeType"].as_str() == Some(mime) {
        if let Some(d) = p["body"]["data"].as_str() {
            if let Some(t) = decode(d).filter(|t| !t.trim().is_empty()) {
                return Some(t);
            }
        }
    }
    p["parts"].as_array()?.iter().find_map(|part| find(part, mime))
}

/// A message's own HTML, as it was sent (None: plain text only).
pub fn html(payload: &Json) -> Option<String> {
    find(payload, "text/html")
}

/// The text of a message: its text/plain part, or (when there's none, or it's blank) its
/// text/html one stripped of tags.
fn body(payload: &Json) -> String {
    // some senders' text/plain is HTML after all (a <style> block, tags): it's cleaned the same way
    let plain = find(payload, "text/plain").map(|t| if looks_like_html(&t) { strip_html(&t) } else { t });
    plain.filter(|t| !t.trim().is_empty()).or_else(|| find(payload, "text/html").map(|h| strip_html(&h))).unwrap_or_default()
}

/// Whether text is HTML in disguise: a style or script block, or the tags of a page.
fn looks_like_html(t: &str) -> bool {
    let lower = t.to_ascii_lowercase();
    ["<style", "<script", "<html", "<body", "<div", "<table", "<br>", "<br/>", "<br />", "</p>"].iter().any(|tag| lower.contains(tag))
}

/// HTML to readable text: no scripts or styles, no tags, the common entities decoded.
pub fn strip_html(h: &str) -> String {
    let mut s = h.to_string();
    for tag in ["style", "script", "head"] {
        // ASCII lowercase keeps every byte offset where it was
        while let Some(start) = s.to_ascii_lowercase().find(&format!("<{tag}")) {
            let lower = s.to_ascii_lowercase();
            let end = lower[start..].find(&format!("</{tag}>")).map(|e| start + e + tag.len() + 3).unwrap_or(s.len());
            s.replace_range(start..end, " ");
        }
    }
    // a block tag ends a line, any other tag is a space
    const BLOCKS: &[&str] = &["p", "br", "div", "li", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "table", "ul", "ol", "blockquote"];
    let mut out = String::with_capacity(s.len());
    let mut tag: Option<String> = None;
    for c in s.chars() {
        match (&mut tag, c) {
            (None, '<') => tag = Some(String::new()),
            (Some(t), '>') => {
                let name: String = t.trim_start_matches('/').chars().take_while(|c| c.is_ascii_alphanumeric()).collect();
                out.push(if BLOCKS.contains(&name.to_ascii_lowercase().as_str()) { '\n' } else { ' ' });
                tag = None;
            }
            (Some(t), c) => t.push(c),
            (None, c) => out.push(c),
        }
    }
    let out = out
        .replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#39;", "'");
    out.lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

/// The new text of a reply, without the quoted message under it.
pub fn strip_quoted(s: &str) -> String {
    let mut out = Vec::new();
    let lines: Vec<&str> = s.lines().collect();
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim();
        let lower = t.to_lowercase();
        // "On …, X <x@y> wrote:" is often wrapped onto two lines
        let with_next = format!("{lower} {}", lines.get(i + 1).map(|l| l.trim().to_lowercase()).unwrap_or_default());
        let header = |start: &str, end: &str| lower.starts_with(start) && (lower.ends_with(end) || with_next.trim_end().ends_with(end));
        let quote_header = header("on ", "wrote:")
            || header("il ", "ha scritto:")
            || lower.starts_with("-----original message-----")
            || lower.starts_with("________________________________");
        if quote_header {
            break;
        }
        if t.starts_with('>') {
            continue;
        }
        out.push(line.trim_end());
    }
    out.join("\n").trim().to_string()
}

/// A header value, RFC 2047-encoded when it isn't plain ASCII.
fn encode_header(s: &str) -> String {
    if s.is_ascii() {
        s.to_string()
    } else {
        format!("=?UTF-8?B?{}?=", STANDARD.encode(s))
    }
}

/// A plain-text reply as `messages.send` wants it (`raw`: base64url of the whole message).
pub fn reply_raw(from: &str, to: &str, cc: &[String], subject: &str, in_reply_to: Option<&str>, references: Option<&str>, text: &str) -> String {
    let subject = if subject.to_lowercase().starts_with("re:") { subject.to_string() } else { format!("Re: {subject}") };
    let mut extra = String::new();
    if !cc.is_empty() {
        extra.push_str(&format!("Cc: {}\r\n", cc.join(", ")));
    }
    if let Some(id) = in_reply_to {
        extra.push_str(&format!("In-Reply-To: {id}\r\n"));
        let refs = references.map(|r| format!("{r} {id}")).unwrap_or_else(|| id.to_string());
        extra.push_str(&format!("References: {refs}\r\n"));
    }
    raw_message(from, to, &subject, &extra, text)
}

/// A new plain-text email, its own thread.
pub fn new_raw(from: &str, to: &str, subject: &str, text: &str) -> String {
    raw_message(from, to, subject, "", text)
}

fn raw_message(from: &str, to: &str, subject: &str, extra_headers: &str, text: &str) -> String {
    let mut m = format!("From: {from}\r\nTo: {to}\r\nSubject: {}\r\nMIME-Version: 1.0\r\n{extra_headers}", encode_header(subject));
    m.push_str("Content-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n");
    let body = STANDARD.encode(text.replace("\r\n", "\n").replace('\n', "\r\n"));
    for chunk in body.as_bytes().chunks(76) {
        m.push_str(std::str::from_utf8(chunk).expect("base64 is ASCII"));
        m.push_str("\r\n");
    }
    URL_SAFE.encode(m)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn a_quote_header_wrapped_onto_two_lines_is_cut() {
        let s = "Ciao come stai?\n\nOn Sun, 1 Nov 2026, 23:14 Alex Doe,\n<alex.doe@example.com> wrote:\n> Hi, could you reply";
        assert_eq!(strip_quoted(s), "Ciao come stai?");
    }

    #[test]
    fn addresses_and_names() {
        assert_eq!(address("\"Rossi, Marco\" <Marco@Example.com>"), ("marco@example.com".into(), Some("Rossi, Marco".into())));
        assert_eq!(address("a@b.c"), ("a@b.c".into(), None));
        assert_eq!(addresses("\"Rossi, Marco\" <m@x.it>, b@y.it").len(), 2);
    }

    #[test]
    fn a_message_and_its_text() {
        let msg = json!({
            "id": "m1", "threadId": "t1", "labelIds": ["INBOX", "UNREAD"], "internalDate": "1793541600000",
            "payload": {
                "mimeType": "multipart/alternative",
                "headers": [
                    {"name": "From", "value": "Marco <marco@example.com>"},
                    {"name": "Subject", "value": "Invoice"},
                    {"name": "Message-ID", "value": "<abc@mail>"}
                ],
                "parts": [
                    {"mimeType": "text/html", "body": {"data": URL_SAFE.encode("<p>html</p>")}},
                    {"mimeType": "text/plain", "body": {"data": URL_SAFE.encode("Can you send it?\n\nOn Mon, Marco wrote:\n> old")}}
                ]
            }
        });
        let p = parse(&msg);
        assert_eq!(p.thread_id, "t1");
        assert_eq!(p.from, Some(("marco@example.com".into(), Some("Marco".into()))));
        assert_eq!(p.message_id.as_deref(), Some("<abc@mail>"));
        assert_eq!(p.body, "Can you send it?");
        assert_eq!(p.internal_date, 1793541600000);
    }

    #[test]
    fn a_blank_text_part_gives_way_to_the_html() {
        let msg = json!({ "payload": { "mimeType": "multipart/alternative", "parts": [
            {"mimeType": "text/plain", "body": {"data": URL_SAFE.encode("  \n ")}},
            {"mimeType": "text/html", "body": {"data": URL_SAFE.encode("<p>Total 120 THB</p>")}}
        ]}});
        assert_eq!(parse(&msg).body, "Total 120 THB");
    }

    #[test]
    fn a_forward_keeps_what_it_forwards() {
        let text = "Get Outlook for Android\n________________________________\nFrom: HubSpot <news@hubspot.com>\nSubject: HubSpot is going away\n\nDear customer, …";
        let msg = |subject: &str| json!({ "payload": { "mimeType": "text/plain",
            "headers": [{"name": "Subject", "value": subject}], "body": {"data": URL_SAFE.encode(text)} }});
        assert!(parse(&msg("FW: HubSpot is going away")).body.contains("Dear customer"));
        assert!(parse(&msg("I: HubSpot is going away")).body.contains("Dear customer"), "Outlook in Italian");
        assert_eq!(parse(&msg("RE: HubSpot is going away")).body, "Get Outlook for Android", "a reply loses the quote");
    }

    #[test]
    fn html_only() {
        assert_eq!(strip_html("<html><head><style>x{}</style></head><body><p>Hi&nbsp;there</p><br>Bye</body></html>"), "Hi there\nBye");
        assert!(looks_like_html("Thanks\n<style type=\"text/css\">a {color: red}</style>"));
        assert!(!looks_like_html("if a < b then 2 > 1"));
    }

    #[test]
    fn a_reply_threads_and_encodes() {
        let raw = reply_raw("me@x.it", "marco@example.com", &["luca@example.com".to_string()], "Fattura €", Some("<abc@mail>"), None, "Ciao,\nfatto.");
        let m = String::from_utf8(URL_SAFE.decode(raw).unwrap()).unwrap();
        assert!(m.contains("Subject: =?UTF-8?B?"));
        assert!(m.contains("Cc: luca@example.com\r\nIn-Reply-To: <abc@mail>\r\nReferences: <abc@mail>\r\n"));
        let body = m.split("\r\n\r\n").nth(1).unwrap().replace("\r\n", "");
        assert_eq!(String::from_utf8(STANDARD.decode(body).unwrap()).unwrap(), "Ciao,\r\nfatto.");
    }

    #[test]
    fn attachments_found_in_parts() {
        let payload = serde_json::json!({ "mimeType": "multipart/mixed", "parts": [
            { "mimeType": "text/plain", "filename": "", "body": { "data": "aGk" } },
            { "mimeType": "application/pdf", "filename": "Invoice.pdf", "body": { "attachmentId": "A1", "size": 1234 } },
            { "mimeType": "multipart/related", "parts": [
                { "mimeType": "image/png", "filename": "logo.png", "body": { "attachmentId": "A2", "size": 10 } } ] } ] });
        let a = attachments(&payload);
        assert_eq!(a.len(), 2);
        assert_eq!((a[0].id.as_str(), a[0].name.as_str(), a[0].size), ("A1", "Invoice.pdf", 1234));
        assert_eq!(a[1].mime, "image/png");
    }
}

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

/// An email's HTML as a page the apps show inside a chat: its scripts, frames, forms and event
/// handlers gone (ammonia), its layout and images kept, links opening outside, on a white page
/// that fits the bubble.
pub fn email_page(html: &str) -> String {
    use std::collections::HashSet;
    let mut tags: HashSet<&str> = ammonia::Builder::default().clone_tags();
    tags.extend(["style", "center", "font", "span", "div", "table", "tbody", "thead", "tfoot", "tr", "td", "th", "img", "u", "s"]);
    let attrs: HashSet<&str> = [
        "style", "class", "align", "valign", "width", "height", "bgcolor", "background", "border", "cellpadding", "cellspacing", "color",
        "face", "size", "dir", "colspan", "rowspan", "title", "alt", "src", "href",
    ]
    .into_iter()
    .collect();
    let body = ammonia::Builder::default()
        .tags(tags)
        .rm_clean_content_tags(["style"])
        .generic_attributes(attrs)
        .link_rel(Some("noopener noreferrer"))
        .url_schemes(["http", "https", "mailto", "tel", "data", "cid"].into_iter().collect())
        .clean(html)
        .to_string();
    let body = fold_quote(&body);
    format!(
        "<!doctype html><html><head><meta charset=\"utf-8\">\
         <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"><base target=\"_blank\">\
         <style>html,body{{margin:0;background:#fff;color:#1a1a1a}}body{{padding:10px;font:14px/1.45 -apple-system,Roboto,Segoe UI,sans-serif;\
         overflow-wrap:anywhere}}img{{max-width:100%!important;height:auto!important}}table{{max-width:100%!important}}\
         details.pigeon-quote>summary{{display:inline-block;list-style:none;cursor:pointer;margin:8px 0;padding:0 8px;border-radius:4px;\
         background:#e8eaed;color:#5f6368;font-weight:700;letter-spacing:1px}}details.pigeon-quote>summary::-webkit-details-marker{{display:none}}</style></head>\
         <body>{body}</body></html>"
    )
}

/// The quoted email under a reply (Gmail's `gmail_quote`, to the end), folded behind "•••" as
/// Gmail shows it: a tap opens it (a `<details>`, no script needed).
fn fold_quote(body: &str) -> String {
    let lower = body.to_ascii_lowercase();
    let Some(class) = lower.find("class=\"gmail_quote") else { return body.to_string() };
    let Some(open) = lower[..class].rfind("<div") else { return body.to_string() };
    if lower[open..class].contains('>') {
        return body.to_string();
    }
    format!("{}<details class=\"pigeon-quote\"><summary>•••</summary>{}</details>", &body[..open], &body[open..])
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

/// A file attached to an email the user sends.
pub struct OutFile {
    pub name: String,
    pub mime: String,
    pub data: Vec<u8>,
}

/// An email's words as they go out: its text, and its HTML (what mail apps show; the text is
/// for the ones that can't).
pub struct Body {
    pub text: String,
    pub html: Option<String>,
}

impl Body {
    pub fn plain(text: &str) -> Body {
        Body { text: text.to_string(), html: None }
    }
}

/// The email being answered, quoted under a reply as Gmail does: `said` is its line ("On Sat,
/// 7 Nov 2026 at 10:25, Marco <marco@x.it> wrote:"), `html` its own page when it had one.
pub struct Quote<'a> {
    pub said: String,
    pub html: Option<&'a str>,
    pub text: &'a str,
}

/// What the user wrote, as an email: their text, their Gmail signature under it (HTML, as Gmail
/// keeps it), the email they answer quoted under that; as HTML laid out the way Gmail writes it
/// (so Gmail folds the quote), and as text.
pub fn compose(text: &str, signature: Option<&str>, quote: Option<&Quote>) -> Body {
    let signature = signature.map(str::trim).filter(|s| !s.is_empty());
    let mut plain = text.trim_end().to_string();
    let mut html = format!("<div dir=\"ltr\">{}</div>", lines_html(text.trim_end()));
    if let Some(sig) = signature {
        plain.push_str(&format!("\n\n-- \n{}", strip_html(sig).trim()));
        html.push_str(&format!(
            "<br><span class=\"gmail_signature_prefix\">-- </span><br><div dir=\"ltr\" class=\"gmail_signature\">{sig}</div>"
        ));
    }
    if let Some(q) = quote {
        let quoted: String = q.text.trim().lines().map(|l| format!("> {l}\n")).collect();
        plain.push_str(&format!("\n\n{}\n{}", q.said, quoted.trim_end()));
        let inner = q.html.map(inner_body).unwrap_or_else(|| lines_html(q.text.trim()));
        html.push_str(&format!(
            "<br><div class=\"gmail_quote gmail_quote_container\"><div dir=\"ltr\" class=\"gmail_attr\">{}<br></div>\
             <blockquote class=\"gmail_quote\" style=\"margin:0px 0px 0px 0.8ex;border-left:1px solid rgb(204,204,204);padding-left:1ex\">{inner}</blockquote></div>",
            escape_html(&q.said)
        ));
    }
    Body { text: plain, html: Some(html) }
}

/// Text made safe for HTML.
pub fn escape_html(t: &str) -> String {
    t.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

/// Text as HTML lines.
fn lines_html(t: &str) -> String {
    escape_html(t).replace("\r\n", "\n").replace('\n', "<br>")
}

/// A page's body, without its head (styles, title): what goes inside a quote.
fn inner_body(html: &str) -> String {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<body").and_then(|b| lower[b..].find('>').map(|e| b + e + 1));
    let end = lower.rfind("</body>");
    match (start, end) {
        (Some(s), Some(e)) if e > s => html[s..e].to_string(),
        (Some(s), _) => html[s..].to_string(),
        _ => html.to_string(),
    }
}

/// A reply as `messages.send` wants it (`raw`: base64url of the whole message).
pub fn reply_raw(from: &str, to: &str, cc: &[String], subject: &str, in_reply_to: Option<&str>, references: Option<&str>, body: &Body) -> String {
    URL_SAFE.encode(reply_message(from, to, cc, subject, in_reply_to, references, body, &[]))
}

/// A reply, with files attached, as the whole message (RFC 822).
#[allow(clippy::too_many_arguments)]
pub fn reply_message(
    from: &str,
    to: &str,
    cc: &[String],
    subject: &str,
    in_reply_to: Option<&str>,
    references: Option<&str>,
    body: &Body,
    files: &[OutFile],
) -> String {
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
    message(from, to, &subject, &extra, body, files)
}

/// A new email, its own thread.
pub fn new_raw(from: &str, to: &str, subject: &str, body: &Body) -> String {
    URL_SAFE.encode(message(from, to, subject, "", body, &[]))
}

/// The whole message: its text, or its text and HTML (multipart/alternative); with files, that
/// and each file, multipart/mixed.
fn message(from: &str, to: &str, subject: &str, extra_headers: &str, body: &Body, files: &[OutFile]) -> String {
    let mut m = format!("From: {from}\r\nTo: {to}\r\nSubject: {}\r\nMIME-Version: 1.0\r\n{extra_headers}", encode_header(subject));
    let one = |m: &mut String, kind: &str, data: &str| {
        m.push_str(&format!("Content-Type: {kind}; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n"));
        push_base64(m, data.replace("\r\n", "\n").replace('\n', "\r\n").as_bytes());
    };
    let text_part = |m: &mut String| match &body.html {
        None => one(m, "text/plain", &body.text),
        Some(html) => {
            let alt = format!("pigeon-alt-{}", uuid::Uuid::new_v4().simple());
            m.push_str(&format!("Content-Type: multipart/alternative; boundary=\"{alt}\"\r\n\r\n--{alt}\r\n"));
            one(m, "text/plain", &body.text);
            m.push_str(&format!("--{alt}\r\n"));
            one(m, "text/html", html);
            m.push_str(&format!("--{alt}--\r\n"));
        }
    };
    if files.is_empty() {
        text_part(&mut m);
        return m;
    }
    let boundary = format!("pigeon-{}", uuid::Uuid::new_v4().simple());
    m.push_str(&format!("Content-Type: multipart/mixed; boundary=\"{boundary}\"\r\n\r\n--{boundary}\r\n"));
    text_part(&mut m);
    for f in files {
        let name = encode_header(&f.name.replace(['"', '\r', '\n'], "_"));
        m.push_str(&format!(
            "--{boundary}\r\nContent-Type: {}; name=\"{name}\"\r\nContent-Disposition: attachment; filename=\"{name}\"\r\nContent-Transfer-Encoding: base64\r\n\r\n",
            f.mime
        ));
        push_base64(&mut m, &f.data);
    }
    m.push_str(&format!("--{boundary}--\r\n"));
    m
}

/// Bytes as base64, in lines of 76.
fn push_base64(m: &mut String, data: &[u8]) {
    let body = STANDARD.encode(data);
    for chunk in body.as_bytes().chunks(76) {
        m.push_str(std::str::from_utf8(chunk).expect("base64 is ASCII"));
        m.push_str("\r\n");
    }
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
    fn a_reply_with_a_file_is_multipart() {
        let f = OutFile { name: "foto.jpg".into(), mime: "image/jpeg".into(), data: vec![0xff, 0xd8, 0xff] };
        let m = reply_message("me@x.it", "a@b.it", &[], "Ciao", Some("<abc@mail>"), None, &Body::plain("eccola"), &[f]);
        assert!(m.contains("Content-Type: multipart/mixed; boundary=\"pigeon-"), "{m}");
        assert!(m.contains("Content-Disposition: attachment; filename=\"foto.jpg\""), "{m}");
        assert!(m.contains(&STANDARD.encode([0xff, 0xd8, 0xff])), "{m}");
        assert!(m.contains("In-Reply-To: <abc@mail>"));
        assert!(m.trim_end().ends_with("--"), "closed");
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
    fn an_email_has_its_html_signature_and_quote() {
        let q = Quote { said: "On Sat, 7 Nov 2026 at 10:25, Marco <m@x.it> wrote:".into(), html: Some("<html><head><style>p{}</style></head><body><p>Ci sei?</p></body></html>"), text: "Ci sei?" };
        let b = compose("Sì <arrivo>\nciao", Some("<b>Francesco</b>"), Some(&q));
        assert_eq!(b.text, "Sì <arrivo>\nciao\n\n-- \nFrancesco\n\nOn Sat, 7 Nov 2026 at 10:25, Marco <m@x.it> wrote:\n> Ci sei?");
        let h = b.html.clone().unwrap();
        assert!(h.starts_with("<div dir=\"ltr\">Sì &lt;arrivo&gt;<br>ciao</div>"), "{h}");
        assert!(h.contains("class=\"gmail_signature\"><b>Francesco</b></div>"), "{h}");
        assert!(h.contains("Marco &lt;m@x.it&gt; wrote:"), "{h}");
        assert!(h.contains("<p>Ci sei?</p></blockquote>") && !h.contains("<style>"), "{h}");
        let m = String::from_utf8(URL_SAFE.decode(new_raw("me@x.it", "m@x.it", "Ciao", &b)).unwrap()).unwrap();
        assert!(m.contains("Content-Type: multipart/alternative; boundary=\"pigeon-alt-"), "{m}");
        assert!(m.contains("Content-Type: text/plain; charset=UTF-8") && m.contains("Content-Type: text/html; charset=UTF-8"), "{m}");
    }

    #[test]
    fn a_quote_is_folded_on_the_page() {
        let page = email_page("<div>Ok</div><div class=\"gmail_quote\"><blockquote>old</blockquote></div>");
        assert!(page.contains("<div>Ok</div><details class=\"pigeon-quote\"><summary>•••</summary><div class=\"gmail_quote\">"), "{page}");
        assert!(!email_page("<div>Ok</div>").contains("<details"));
    }

    #[test]
    fn a_reply_threads_and_encodes() {
        let raw = reply_raw("me@x.it", "marco@example.com", &["luca@example.com".to_string()], "Fattura €", Some("<abc@mail>"), None, &Body::plain("Ciao,\nfatto."));
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

    #[test]
    fn email_page_is_safe_and_keeps_the_layout() {
        let page = email_page(
            "<html><head><style>.x{color:red}</style><script>alert(1)</script></head><body>\
             <table width=\"600\"><tr><td class=\"x\" style=\"padding:4px\" onclick=\"steal()\">Hi <a href=\"javascript:alert(1)\">bad</a> \
             <a href=\"https://x.y/z\">good</a><img src=\"https://x.y/i.png\"></td></tr></table><iframe src=\"https://evil\"></iframe></body></html>",
        );
        assert!(!page.contains("<script") && !page.contains("alert(1)") && !page.contains("onclick") && !page.contains("<iframe"), "{page}");
        assert!(page.contains(".x{color:red}") && page.contains("style=\"padding:4px\"") && page.contains("https://x.y/z") && page.contains("<img"), "{page}");
        assert!(page.contains("<base target=\"_blank\">"));
    }
}

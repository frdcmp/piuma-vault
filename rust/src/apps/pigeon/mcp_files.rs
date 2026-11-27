//! The Inbox's files over MCP (`mcp_server`), next to Pigeon's tools: what `pigeon.py file` and
//! `pigeon.py upload` do with a key, for an assistant that has only the MCP. They're not Piuma's
//! (she reads what a file is from a message's `files` and attaches none), so not in `tools`.
//!
//! `pigeon_file` (`inbox.read`, as `GET /admin/pigeon/items/{id}/media/{file}`): a message's
//! stored file as MCP content: an image as an `image` block, a text-like file as its words (at
//! most `TEXT_MAX`, saying when cut), anything else as what it is, its size and that it can't be
//! shown here. Every answer carries `download_url`: the file itself, at a link storage signs for
//! `LINK_SECS`, for an assistant that can fetch one (a PDF, a spreadsheet, a video). `pigeon_upload` (`inbox.write`, as `POST /admin/pigeon/files`): a file sent up in
//! base64, stored as the user's to attach to an email: the `file` object the draft tools take.

use base64::Engine;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::connectors::gmail::MAX_ATTACHMENT;
use crate::apps::pigeon::media;
use crate::apps::pigeon::state::AppState;

/// The most of a text-like file shown; the rest is cut, and the answer says so.
const TEXT_MAX: usize = 200 * 1024;

/// The largest image shown as one (a model takes up to 5 MB an image); a bigger one is told about.
const IMAGE_MAX: usize = 5 << 20;

/// How long a file's download link lasts.
const LINK_SECS: u64 = 600;

/// The images a model can see.
const IMAGES: &[&str] = &["image/jpeg", "image/png", "image/gif", "image/webp"];

/// A file's name that says it's text, when its type doesn't.
const TEXT_EXTENSIONS: &[&str] = &[
    "txt", "md", "markdown", "csv", "tsv", "json", "xml", "yaml", "yml", "toml", "ini", "log", "html", "htm", "ics", "vcf", "srt",
    "vtt", "eml", "sql", "sh", "py", "js", "ts", "rs",
];

pub fn names() -> Vec<&'static str> {
    defs().into_iter().map(|(n, _, _)| n).collect()
}

/// The scope a caller needs, as the endpoints check it; none: not one of these.
pub fn scope(name: &str) -> Option<&'static str> {
    match name {
        "pigeon_file" => Some("inbox.read"),
        "pigeon_upload" => Some("inbox.write"),
        _ => None,
    }
}

pub fn defs() -> Vec<(&'static str, &'static str, Json)> {
    vec![
        (
            "pigeon_file",
            "A message's file, to look at: an image (JPEG, PNG, GIF, WebP up to 5 MB) comes as the image itself; a text-like file (text, CSV, JSON, markdown, an .ics…) as its text, at most 200 KB (the answer says when it's cut); anything else (a PDF, a Word or Excel file, a video, a voice note) as what it is and its size: it can't be shown here (a voice note's words are its `transcript` in the message's `files`). Every answer has `download_url`, the file itself at a link good for 10 minutes: fetch it (`curl -sfL '<download_url>' -o <name>`) to open what can't be shown, or to keep a copy; call again for a fresh link, and never pass the link on to anyone. Only a `stored` file: an `expired` or `gone` one is no longer kept. The ids are under each message's `files` in pigeon_conversation or pigeon_search.",
            json!({ "type": "object", "properties": {
                "item_id": { "type": "string", "description": "The message's id" },
                "file_id": { "type": "string", "description": "The file's id, from the message's `files`" },
            }, "required": ["item_id", "file_id"] }),
        ),
        (
            "pigeon_upload",
            "Store a file to attach to an email, sent here in base64: it is stored as the user's, not sent. Returns `file`: pass it as it is, in `files`, to pigeon_draft_email, or to pigeon_draft_reply or pigeon_send_reply in an email conversation. One file a call, at most 25 MB; one email takes at most 10 files and 25 MB in all.",
            json!({ "type": "object", "properties": {
                "name": { "type": "string", "description": "The file's name, as the email shows it, e.g. invoice.pdf" },
                "mime_type": { "type": "string", "description": "Its type, e.g. application/pdf, image/jpeg" },
                "data": { "type": "string", "description": "The file's bytes in base64" },
            }, "required": ["name", "mime_type", "data"] }),
        ),
    ]
}

fn text(t: impl Into<String>) -> Json {
    json!({ "type": "text", "text": t.into() })
}

fn pretty(v: &Json) -> String {
    serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string())
}

/// Run one as the user (who holds its scope: the server checked): its MCP content blocks.
pub async fn call(st: &AppState, user: &str, name: &str, args: &Json) -> Result<Vec<Json>, String> {
    match name {
        "pigeon_file" => file(st, user, args).await.map_err(|e| format!("{e:#}")),
        "pigeon_upload" => upload(st, user, args).await.map_err(|e| format!("{e:#}")),
        other => Err(format!("no tool {other}")),
    }
}

/// How a file can be shown here.
#[derive(Debug, PartialEq)]
enum Shown {
    Image,
    Text,
    Not,
}

fn shown_as(mime: &str, name: Option<&str>) -> Shown {
    let m = mime.split(';').next().unwrap_or_default().trim().to_lowercase();
    if IMAGES.contains(&m.as_str()) {
        return Shown::Image;
    }
    let textual = m.starts_with("text/")
        || m.ends_with("+json")
        || m.ends_with("+xml")
        || matches!(
            m.as_str(),
            "application/json" | "application/xml" | "application/javascript" | "application/yaml" | "application/x-yaml"
                | "application/toml" | "application/sql" | "application/x-sh" | "application/csv" | "message/rfc822"
        );
    // a type that says nothing: the name's extension decides
    let by_name = (m.is_empty() || m == "application/octet-stream")
        && name
            .and_then(|n| n.rsplit_once('.'))
            .is_some_and(|(_, ext)| TEXT_EXTENSIONS.contains(&ext.to_lowercase().as_str()));
    if textual || by_name {
        Shown::Text
    } else {
        Shown::Not
    }
}

/// A text-like file's first bytes as text: a character the cut split is left out.
fn text_of(bytes: &[u8]) -> String {
    let whole = match std::str::from_utf8(bytes) {
        Err(e) if e.error_len().is_none() => &bytes[..e.valid_up_to()],
        _ => bytes,
    };
    String::from_utf8_lossy(whole).into_owned()
}

/// A stored file's first `max` bytes, and whether there was more.
async fn first_bytes(st: &AppState, key: &str, max: usize) -> anyhow::Result<(Vec<u8>, bool)> {
    let mut body = media::open(&st.pool, key).await?;
    let mut out = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|e| anyhow::anyhow!("reading it: {e}"))?;
        out.extend_from_slice(&chunk);
        if out.len() > max {
            out.truncate(max);
            return Ok((out, true));
        }
    }
    Ok((out, false))
}

async fn file(st: &AppState, user: &str, args: &Json) -> anyhow::Result<Vec<Json>> {
    let item = crate::apps::pigeon::tools::opt_uuid(args, "item_id")?.ok_or_else(|| anyhow::anyhow!("`item_id` is required (the message's id)"))?;
    let id = args.get("file_id").and_then(Json::as_str).map(str::trim).filter(|s| !s.is_empty());
    let id = id.ok_or_else(|| anyhow::anyhow!("`file_id` is required (from the message's `files`)"))?;
    let entry = media::stored(&st.pool, user, item, id).await?;
    let key = entry["key"].as_str().unwrap_or_default().to_string();
    // what it is, as the tools tell a message's files (never where it's kept)
    let mut about = media::told(&json!([entry.clone()])).pop().unwrap_or_else(|| json!({}));
    let mime = entry["mime"].as_str().unwrap_or("application/octet-stream").to_string();
    let size = entry["size"].as_u64();
    // the file itself, for an assistant that can fetch it; without a link the rest still stands
    match media::signed_link(&st.pool, &key, entry["name"].as_str(), LINK_SECS).await {
        Ok(url) => {
            about["download_url"] = json!(url);
            about["download_expires_in_seconds"] = json!(LINK_SECS);
        }
        Err(e) => log::warn!("pigeon_file: no link for {id}: {e:#}"),
    }
    match shown_as(&mime, entry["name"].as_str()) {
        Shown::Image if size.is_none_or(|s| s as usize <= IMAGE_MAX) => {
            let (bytes, more) = first_bytes(st, &key, IMAGE_MAX).await?;
            if !more {
                let data = base64::engine::general_purpose::STANDARD.encode(&bytes);
                let base = mime.split(';').next().unwrap_or_default().trim().to_lowercase();
                return Ok(vec![text(pretty(&about)), json!({ "type": "image", "data": data, "mimeType": base })]);
            }
            about["note"] = json!(format!("An image over {} MB: too big to show here.", IMAGE_MAX >> 20));
        }
        Shown::Image => about["note"] = json!(format!("An image over {} MB: too big to show here.", IMAGE_MAX >> 20)),
        Shown::Text => {
            let (bytes, cut) = first_bytes(st, &key, TEXT_MAX).await?;
            if cut {
                let of = size.map(|s| format!(" of {s} bytes")).unwrap_or_default();
                about["note"] = json!(format!("Cut: the first {} KB{of} only; the rest isn't here.", TEXT_MAX >> 10));
            }
            return Ok(vec![text(pretty(&about)), text(text_of(&bytes))]);
        }
        Shown::Not => {
            let kind = about["kind"].as_str().unwrap_or("file").to_string();
            about["note"] = json!(format!("A {kind} ({mime}): it can't be shown here: fetch download_url to open it, or the user can open it in the Inbox."));
        }
    }
    Ok(vec![text(pretty(&about))])
}

/// An upload's name, type and bytes, checked as the endpoint checks one, and against what one
/// email may carry.
fn upload_parts(args: &Json) -> anyhow::Result<(String, String, Vec<u8>)> {
    let name = args.get("name").and_then(Json::as_str).unwrap_or_default();
    // its own name, never a path
    let name = std::path::Path::new(name.trim()).file_name().and_then(|n| n.to_str()).unwrap_or_default().trim().to_string();
    if name.is_empty() {
        anyhow::bail!("`name` is required: the file's name, e.g. invoice.pdf");
    }
    let mime = args.get("mime_type").and_then(Json::as_str).unwrap_or_default();
    let mime = mime.split(';').next().unwrap_or_default().trim().to_lowercase();
    if !mime.split_once('/').is_some_and(|(a, b)| !a.is_empty() && !b.is_empty() && !b.contains('/')) {
        anyhow::bail!("`mime_type`: a type like application/pdf or image/jpeg");
    }
    let data = args.get("data").and_then(Json::as_str).unwrap_or_default();
    // a data: URL's head, and the line breaks base64 often comes with, aren't the file
    let data = data.split_once(";base64,").map_or(data, |(_, d)| d);
    let data: String = data.chars().filter(|c| !c.is_whitespace()).collect();
    if data.is_empty() {
        anyhow::bail!("`data` is required: the file's bytes in base64");
    }
    let max = MAX_ATTACHMENT as usize;
    let over = || anyhow::anyhow!("the file is over {} MB, the most one email carries", max >> 20);
    if data.len() / 4 * 3 > max + 3 {
        return Err(over());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data.as_bytes())
        .map_err(|_| anyhow::anyhow!("`data` isn't base64"))?;
    if bytes.is_empty() {
        anyhow::bail!("the file is empty");
    }
    if bytes.len() > max {
        return Err(over());
    }
    Ok((name, mime, bytes))
}

async fn upload(st: &AppState, user: &str, args: &Json) -> anyhow::Result<Vec<Json>> {
    let (name, mime, bytes) = upload_parts(args)?;
    let tmp = std::env::temp_dir().join(format!("pigeon-upload-{}", Uuid::new_v4()));
    let r: anyhow::Result<Json> = async {
        tokio::fs::write(&tmp, &bytes).await?;
        media::put_outgoing(&st.pool, user, "outbox", &mime, Some(&name), &tmp, bytes.len() as i64, &[]).await
    }
    .await;
    let _ = tokio::fs::remove_file(&tmp).await;
    Ok(vec![text(pretty(&json!({ "file": r? })))])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scopes_are_the_endpoints() {
        assert_eq!(scope("pigeon_file"), Some("inbox.read"));
        assert_eq!(scope("pigeon_upload"), Some("inbox.write"));
        assert_eq!(scope("pigeon_inbox"), None);
        assert_eq!(names(), ["pigeon_file", "pigeon_upload"]);
        // not Piuma's: none of her Inbox tools has their names
        assert!(names().iter().all(|n| !crate::apps::pigeon::tools::names().contains(n)));
    }

    #[test]
    fn what_can_be_shown() {
        assert_eq!(shown_as("image/jpeg", None), Shown::Image);
        assert_eq!(shown_as("IMAGE/PNG; charset=x", None), Shown::Image);
        assert_eq!(shown_as("image/heic", Some("a.heic")), Shown::Not);
        assert_eq!(shown_as("text/plain; charset=utf-8", None), Shown::Text);
        assert_eq!(shown_as("text/calendar", Some("invite.ics")), Shown::Text);
        assert_eq!(shown_as("application/json", None), Shown::Text);
        assert_eq!(shown_as("image/svg+xml", None), Shown::Text);
        assert_eq!(shown_as("application/octet-stream", Some("notes.MD")), Shown::Text);
        assert_eq!(shown_as("", Some("data.csv")), Shown::Text);
        // the name decides only when the type says nothing
        assert_eq!(shown_as("application/pdf", Some("report.txt")), Shown::Not);
        assert_eq!(shown_as("application/pdf", Some("report.pdf")), Shown::Not);
        assert_eq!(shown_as("audio/ogg", None), Shown::Not);
        assert_eq!(shown_as("application/octet-stream", Some("blob")), Shown::Not);
    }

    #[test]
    fn a_cut_leaves_out_the_split_character() {
        assert_eq!(text_of("caffè".as_bytes()), "caffè");
        let b = "caffè".as_bytes();
        assert_eq!(text_of(&b[..b.len() - 1]), "caff");
        assert_eq!(text_of(&[0x66, 0xff, 0x6f]), "f\u{fffd}o");
    }

    #[test]
    fn an_upload_is_checked() {
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        let ok = upload_parts(&json!({ "name": "../x/Invoice.pdf", "mime_type": "Application/PDF; q=1", "data": b64(b"%PDF-1") })).unwrap();
        assert_eq!(ok, ("Invoice.pdf".to_string(), "application/pdf".to_string(), b"%PDF-1".to_vec()));
        // a data: URL and line breaks are fine
        let url = format!("data:text/plain;base64,{}\n", b64(b"hello"));
        assert_eq!(upload_parts(&json!({ "name": "a.txt", "mime_type": "text/plain", "data": url })).unwrap().2, b"hello");

        let err = |args: Json| upload_parts(&args).unwrap_err().to_string();
        assert!(err(json!({ "mime_type": "text/plain", "data": b64(b"x") })).contains("`name`"));
        assert!(err(json!({ "name": "a", "mime_type": "pdf", "data": b64(b"x") })).contains("`mime_type`"));
        assert!(err(json!({ "name": "a", "mime_type": "text/plain" })).contains("`data`"));
        assert!(err(json!({ "name": "a", "mime_type": "text/plain", "data": "not base64!" })).contains("base64"));
        let big = "A".repeat((MAX_ATTACHMENT as usize) / 3 * 4 + 8);
        assert!(err(json!({ "name": "a", "mime_type": "text/plain", "data": big })).contains("25 MB"));
    }
}

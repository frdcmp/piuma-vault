//! Navigation tool — lets the agent actively *take* the user somewhere rather
//! than only offering an inline link. It performs no DB work: it validates the
//! requested target and echoes a normalized intent. The frontend reads the
//! tool's announced args and renders a one-click "Go" action (it does not
//! auto-redirect — a silent jump is hostile and risks loops). The id, if any,
//! is whatever the agent pulled from an earlier tool result.

use serde_json::{json, Value};

use super::opt_string;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "navigate",
        "Offer the user a one-click button to jump to a specific note, calendar event, or task, \
         to an app view, or to an external web page. Use this when the user asks to be taken / \
         shown / opened somewhere; for a passing mention prefer an inline markdown link instead. \
         Ids must come from a previous tool result.",
        json!({
            "type": "object",
            "properties": {
                "target": {
                    "type": "string",
                    "enum": ["note", "event", "task", "view", "url"],
                    "description": "what to open"
                },
                "id": { "type": "string", "description": "uuid of the note/event/task (for target note|event|task)" },
                "route": {
                    "type": "string",
                    "enum": ["notes", "tasks", "calendar", "storage"],
                    "description": "which view to open (for target=view)"
                },
                "url": { "type": "string", "description": "http(s) URL (for target=url)" },
                "label": { "type": "string", "description": "short human label for the button, e.g. the entity title" }
            },
            "required": ["target"]
        }),
    )]
}

/// Validate the requested navigation and return a normalized intent. The result
/// goes back to the model as confirmation; the client builds the actual button
/// from the tool's announced args.
pub async fn navigate(args: &Value) -> Result<Value, String> {
    let target = opt_string(args, "target")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty())
        .ok_or("`target` is required (note|event|task|view|url)")?;
    let id = opt_string(args, "id").filter(|s| !s.trim().is_empty());
    let route = opt_string(args, "route")
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let url = opt_string(args, "url").filter(|s| !s.trim().is_empty());
    let label = opt_string(args, "label").filter(|s| !s.trim().is_empty());

    match target.as_str() {
        "note" | "event" | "task" => {
            let id_ref = id
                .as_deref()
                .ok_or_else(|| format!("`id` is required when target is `{target}`"))?;
            // Lightweight UUID shape check — the entity itself is validated when
            // the client navigates (and shows a toast if it's gone).
            if uuid::Uuid::parse_str(id_ref).is_err() {
                return Err("`id` must be a UUID from a tool result".into());
            }
        }
        "view" => {
            let r = route
                .as_deref()
                .ok_or("`route` is required when target is `view` (notes|tasks|calendar|storage)")?;
            if !matches!(r, "notes" | "tasks" | "calendar" | "storage") {
                return Err("`route` must be one of: notes, tasks, calendar, storage".into());
            }
        }
        "url" => {
            let u = url
                .as_deref()
                .ok_or("`url` is required when target is `url`")?;
            if !(u.starts_with("http://") || u.starts_with("https://")) {
                return Err("`url` must be an http(s) URL".into());
            }
        }
        other => return Err(format!("unknown target `{other}`")),
    }

    Ok(json!({
        "ok": true,
        "navigate": { "target": target, "id": id, "route": route, "url": url, "label": label },
        "message": "Showed the user a one-click Go button."
    }))
}

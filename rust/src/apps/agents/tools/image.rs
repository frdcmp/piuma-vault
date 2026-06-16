//! Image generation tool. Generates an image from a prompt via the configured
//! provider (admin → Services → Images), stores it in S3, and returns a stable
//! CDN URL. The model should embed it as markdown `![alt](url)` so the chat
//! renders it inline.

use serde_json::{json, Value};

use super::*;
use crate::db::db::DbPool;

pub fn defs() -> Vec<(&'static str, &'static str, Value)> {
    vec![(
        "generate_image",
        "Generate an image from a text prompt. Returns a CDN `url`; embed it in your reply as markdown ![alt](url) so it renders inline. Use when the user asks to create/draw/visualise/generate an image.",
        json!({
            "type": "object",
            "properties": {
                "prompt": { "type": "string", "description": "detailed description of the image to generate" },
                "size": {
                    "type": "string",
                    "enum": ["1024x1024", "1536x1024", "1024x1536"],
                    "description": "image dimensions; default 1024x1024 (square)"
                }
            },
            "required": ["prompt"]
        }),
    )]
}

pub async fn generate_image(pool: &DbPool, user_id: &str, args: &Value) -> Result<Value, String> {
    let prompt = req_str(args, "prompt")?;
    let size = opt_string(args, "size")
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "1024x1024".to_string());
    let stored =
        crate::apps::image_gen::core::generate_and_store(pool, user_id, &prompt, &size, 1, "agent_tool")
            .await?;
    let img = stored.into_iter().next().ok_or("no image was produced")?;
    Ok(json!({
        "url": img.cdn_url,
        "prompt": prompt,
        "provider": img.provider,
        "model": img.model,
        "markdown": format!("![{}]({})", prompt.replace(']', " "), img.cdn_url),
        "title": "Generated image",
    }))
}

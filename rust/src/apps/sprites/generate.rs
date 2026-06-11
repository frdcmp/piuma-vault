//! One-shot LLM sprite generation.
//!
//! Turns a short natural-language prompt into a full `SpriteDefinition` using
//! the default agent model. Reuses the same provider abstraction the chat path
//! uses (`providers::complete`), the same default-model selection as the title
//! generator, and feeds the built-in Piuma sprite as a few-shot example so the
//! model learns the exact grid/palette contract. The result is validated but
//! NOT saved — the admin reviews and tweaks it in the editor before saving.

use serde_json::json;

use crate::apps::agents::models::{ModelRow, ProviderRow};
use crate::apps::agents::providers;
use crate::db::db::DbPool;

use super::models::SpriteDefinition;

/// The Piuma mascot, used as the one-shot example. Keep in sync with `seed.rs`.
const PIUMA_EXAMPLE: &str = r##"{
  "palette": {"B":"#ad7549","W":"#f5f5f5","M":"#f5f5f5","E":"#0d0d0d","N":"#000000","Y":"#090909","T":"#ff7a9a","C":"#c0392b"},
  "body": [
    "................",".....EEBB.......","....EBBBBB......","...BBBBBBBB.....",
    "...BBYBBYBB.BBB.","...BMMNMMBBBBBB.","...BBMTMBBBBBBB.","...CCCCCCCCCCC..",
    "...BWWWWWWWWBB..","...BWWWWWWWWBB.."
  ],
  "idleLegs": ["...B.B....B.B...","...B.B....B.B..."],
  "walkLegs": [
    ["..B..B....BB....",".....B....B....."],
    ["...B.B....B.B...","...B.B....B.B..."],
    ["...BB....B..B...","...B........B..."],
    ["...B.B....B.B...","...B.B....B.B..."]
  ],
  "walkFrameMs": 120,
  "gallopLegs": [
    ["..B.B.....B.B...","..B.B.......B.B."],
    ["....B.B...B.B...","....B.B..B.B...."]
  ],
  "gallopFrameMs": 140
}"##;

const SYSTEM: &str = "You are a pixel-art sprite generator for a small side-view \
animal mascot. You output ONLY a JSON object describing the sprite — no prose, \
no markdown fences, no comments.

The sprite is a 16-column pixel grid. Each row is a string of exactly 16 \
characters. Each character is either '.' (transparent) or a single uppercase \
letter that is a key in `palette` (mapping the letter to a hex color like \
\"#ad7549\"). Use as many palette colors as the creature needs.

The grid is split into a shared body and per-pose legs:
- `body`: exactly 10 rows — the head/torso, identical across every pose.
- `idleLegs`: exactly 2 rows — the legs while standing still.
- `walkLegs`: an array of animation frames; each frame is exactly 2 rows. \
Cycle the leg positions so the walk reads as steps.
- `gallopLegs`: an array of frames; each frame is exactly 2 rows. A faster, \
wider stride than the walk.
- `walkFrameMs` and `gallopFrameMs`: integers, milliseconds per frame \
(roughly 100-160; gallop slightly faster-feeling than walk).

Hard rules — the output is rejected if any are broken:
- Every row everywhere is EXACTLY 16 characters.
- `body` has exactly 10 rows; every leg frame has exactly 2 rows.
- `palette` is non-empty; only '.' and palette letters appear in any row.
- The creature faces to the side and sits in the lower-middle of the grid, \
with its feet on the bottom leg rows, like the example.

Here is a complete, valid example sprite (the mascot \"Piuma\"). Match this \
structure and quality exactly, but design a NEW creature for the user's prompt:

EXAMPLE:
";

/// Generate a `SpriteDefinition` from a natural-language prompt. Returns the
/// validated definition (not persisted) or a human-readable error.
pub async fn generate_sprite(pool: &DbPool, prompt: &str) -> Result<SpriteDefinition, String> {
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err("prompt is empty".into());
    }

    // Default enabled model + provider — same selection the chat path uses for
    // an agent with no explicit model.
    let model: ModelRow =
        sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
            .fetch_optional(pool)
            .await
            .map_err(|e| e.to_string())?
            .ok_or("no default model configured")?;
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("provider not found")?;
    if !providers::supported(&provider.kind) || provider.api_key.trim().is_empty() {
        return Err("the default model's provider is not configured".into());
    }

    let system = format!("{SYSTEM}{PIUMA_EXAMPLE}");
    let messages = vec![
        json!({ "role": "system", "content": system }),
        json!({
            "role": "user",
            "content": format!(
                "Design a sprite for: {prompt}\n\nReply with ONLY the JSON object."
            )
        }),
    ];

    // Generous budget: the JSON is sizeable and the default model is a reasoning
    // model, so a small cap leaves `content` empty (all tokens go to reasoning).
    let raw = providers::complete(
        &provider.kind,
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        &messages,
        16000,
    )
    .await
    .map_err(|e| format!("generation failed: {e}"))?;

    let json_str = extract_json(&raw)
        .ok_or("the model did not return a JSON object")?;
    let mut def: SpriteDefinition = serde_json::from_str(json_str)
        .map_err(|e| format!("the model returned malformed sprite JSON: {e}"))?;
    // Models drift off the grid contract (a row a char too long, 9 body rows
    // instead of 10). Repair to the canonical shape rather than reject a sprite
    // the admin can fix in two clicks; validate() is the remaining safety net.
    normalize(&mut def);
    def.validate()?;
    Ok(def)
}

const GRID_WIDTH: usize = 16;
const BODY_ROWS: usize = 10;
const LEG_ROWS: usize = 2;

/// Coerce a parsed definition onto the fixed grid: every row exactly
/// `GRID_WIDTH` chars (pad with '.', truncate overflow), `body` exactly
/// `BODY_ROWS`, every leg frame exactly `LEG_ROWS`, and non-zero frame timings.
fn normalize(def: &mut SpriteDefinition) {
    def.body = fit_rows(std::mem::take(&mut def.body), BODY_ROWS);
    def.idle_legs = fit_rows(std::mem::take(&mut def.idle_legs), LEG_ROWS);
    if def.walk_legs.is_empty() {
        def.walk_legs.push(Vec::new());
    }
    if def.gallop_legs.is_empty() {
        def.gallop_legs.push(Vec::new());
    }
    for frame in def.walk_legs.iter_mut().chain(def.gallop_legs.iter_mut()) {
        *frame = fit_rows(std::mem::take(frame), LEG_ROWS);
    }
    if def.walk_frame_ms == 0 {
        def.walk_frame_ms = 120;
    }
    if def.gallop_frame_ms == 0 {
        def.gallop_frame_ms = 140;
    }
}

/// Force a single row to exactly `GRID_WIDTH` characters.
fn fit_row(row: &str) -> String {
    let mut r: String = row.chars().take(GRID_WIDTH).collect();
    while r.chars().count() < GRID_WIDTH {
        r.push('.');
    }
    r
}

/// Force a list of rows to exactly `n` rows of `GRID_WIDTH` chars each.
fn fit_rows(rows: Vec<String>, n: usize) -> Vec<String> {
    let mut out: Vec<String> = rows.iter().map(|r| fit_row(r)).collect();
    out.truncate(n);
    while out.len() < n {
        out.push(".".repeat(GRID_WIDTH));
    }
    out
}

/// Pull the first balanced `{...}` object out of the model's reply, tolerating
/// markdown code fences and any leading/trailing prose.
fn extract_json(raw: &str) -> Option<&str> {
    let start = raw.find('{')?;
    let mut depth = 0usize;
    let mut in_str = false;
    let mut escaped = false;
    for (i, ch) in raw[start..].char_indices() {
        if in_str {
            if escaped {
                escaped = false;
            } else if ch == '\\' {
                escaped = true;
            } else if ch == '"' {
                in_str = false;
            }
            continue;
        }
        match ch {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(&raw[start..start + i + 1]);
                }
            }
            _ => {}
        }
    }
    None
}

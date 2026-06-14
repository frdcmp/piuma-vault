//! One-shot LLM sprite generation.
//!
//! Turns a short natural-language prompt into a full `SpriteDefinition` using
//! the default agent model. Reuses the same provider abstraction the chat path
//! uses (`providers::complete`), the same default-model selection as the title
//! generator, and feeds the built-in Piuma sprite as a few-shot FORMAT example.
//!
//! Two passes: a first draft, then a self-critique pass where the model is shown
//! its own sprite rendered back on the grid and asked to fix the things text
//! models get wrong drawing blind (edge-to-edge fill, front-facing symmetry,
//! missing margins). The refine is best-effort — an invalid second pass falls
//! back to the draft.

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

const SYSTEM: &str = "You are a pixel-art sprite artist. You draw one small \
animal mascot, in SIDE PROFILE (facing right), on a tiny grid, and output ONLY \
a JSON object describing it — no prose, no markdown fences, no comments.

THE GRID
The sprite is 16 columns wide. Each row is a string of exactly 16 characters. \
Each character is either '.' (transparent / empty) or a single uppercase letter \
that is a key in `palette` (letter -> hex color like \"#ad7549\"). Use as many \
palette colors as the creature needs (shading, outline, eyes, belly…).

The grid is split into a shared body and swappable legs:
- `body`: exactly 10 rows — the head + torso, identical across every pose.
- `idleLegs`: exactly 2 rows — legs while standing.
- `walkLegs`: array of frames, each exactly 2 rows. Step the legs so it reads \
as walking.
- `gallopLegs`: array of frames, each exactly 2 rows. A wider, faster stride.
- `walkFrameMs` / `gallopFrameMs`: integers, ms per frame (~100-160).

HOW TO DRAW WELL — this is what separates a good sprite from a blob:
1. SILHOUETTE FIRST. The creature must have a clear, readable outline that says \
'monkey' / 'owl' / 'fox' at a glance. Think about its real-world shape in \
profile (snout, ears, tail, hunched back) — not a symmetric centered lump.
2. SIDE PROFILE, not a face. We see it from the side: ONE eye, a snout/beak \
pointing right, legs underneath. Do NOT draw a front-facing symmetric face with \
two eyes — that is the #1 mistake.
3. LEAVE MARGINS. Keep at least 1-2 transparent ('.') columns on the left and \
right. The creature should float in the field, surrounded by empty space.
4. NEVER fill a row edge-to-edge. A row that is all letters (like \
\"BBBBBBBBBBBBBBBB\") looks like a wall or shelf and ruins the sprite. If you \
catch yourself doing this, you are padding — stop.
5. DO NOT PAD TO FILL ROWS. `body` is exactly 10 rows, but if your creature is \
shorter, the EXTRA rows must be the TOP rows and they must be fully transparent \
(all '.'). Anchor the creature at the BOTTOM of the body so its feet meet the \
legs. Empty space goes ABOVE, never as filler.
6. Legs live only in the 2 leg rows; keep them thin (1-2 px each) and animate \
their position between frames.

Hard rules — output is rejected if broken:
- Every row everywhere is EXACTLY 16 characters.
- `body` has exactly 10 rows; every leg frame has exactly 2 rows.
- `palette` is non-empty; only '.' and palette letters appear in any row.

Below is a VALID example (the bird mascot \"Piuma\") so you can see the JSON \
FORMAT and the level of detail. Match the FORMAT exactly, but invent a \
completely different silhouette for the user's creature — do not copy Piuma's \
shape, colors, or layout.

FORMAT EXAMPLE:
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
    let user = format!("Design a sprite for: {prompt}\n\nReply with ONLY the JSON object.");
    let messages = vec![
        json!({ "role": "system", "content": &system }),
        json!({ "role": "user", "content": &user }),
    ];

    // First draft.
    let draft = complete_definition(&provider, &model, &messages).await?;

    // Self-critique pass: show the model its own sprite rendered on the grid and
    // let it fix the things text models get wrong blind — edge-to-edge fill,
    // front-facing symmetry, no margins. Best-effort: a failed/invalid refine
    // keeps the draft rather than erroring the whole request.
    let refine = format!(
        "Here is the sprite you produced, drawn on the 16-wide grid (idle pose = \
body + idleLegs; '.' is transparent):\n\n```\n{grid}\n```\n\npalette: {palette}\n\n\
Critique it honestly, then REDRAW it better. Check specifically:\n\
- Is any row filled edge-to-edge (a solid wall/shelf)? Remove it.\n\
- Is it a SIDE PROFILE with one eye and a snout facing right — or did you draw a \
flat front-facing symmetric face? Make it a side profile.\n\
- Are there transparent margins on the left and right? Is the creature anchored \
at the bottom with empty space above (not filler)?\n\
- Does the silhouette clearly read as \"{prompt}\"?\n\n\
Output ONLY the improved JSON object, same format.",
        grid = render_idle(&draft),
        palette = serde_json::to_string(&draft.palette).unwrap_or_default(),
    );
    let draft_json = serde_json::to_string(&draft).unwrap_or_default();
    let refine_messages = vec![
        json!({ "role": "system", "content": &system }),
        json!({ "role": "user", "content": &user }),
        json!({ "role": "assistant", "content": draft_json }),
        json!({ "role": "user", "content": refine }),
    ];

    match complete_definition(&provider, &model, &refine_messages).await {
        Ok(improved) => Ok(improved),
        Err(e) => {
            log::warn!("sprites: refine pass failed, keeping first draft: {e}");
            Ok(draft)
        }
    }
}

/// One LLM round-trip → a validated, normalized `SpriteDefinition`.
async fn complete_definition(
    provider: &ProviderRow,
    model: &ModelRow,
    messages: &[serde_json::Value],
) -> Result<SpriteDefinition, String> {
    // Generous budget: the JSON is sizeable and the model may be a reasoning
    // model, so a small cap leaves `content` empty (all tokens go to reasoning).
    let raw = providers::complete(
        &provider.kind,
        &provider.api_key,
        provider.base_url.as_deref(),
        &model.model_id,
        messages,
        16000,
    )
    .await
    .map_err(|e| format!("generation failed: {e}"))?;

    let json_str = extract_json(&raw).ok_or("the model did not return a JSON object")?;
    let mut def: SpriteDefinition = serde_json::from_str(json_str)
        .map_err(|e| format!("the model returned malformed sprite JSON: {e}"))?;
    // Models drift off the grid contract (a row a char too long, 9 body rows
    // instead of 10). Repair to the canonical shape rather than reject a sprite
    // the admin can fix in two clicks; validate() is the remaining safety net.
    normalize(&mut def);
    def.validate()?;
    Ok(def)
}

/// Render the idle pose (body + idle legs) as its raw grid, for the refine pass
/// to "see" what it drew.
fn render_idle(def: &SpriteDefinition) -> String {
    def.body
        .iter()
        .chain(def.idle_legs.iter())
        .cloned()
        .collect::<Vec<_>>()
        .join("\n")
}

const GRID_WIDTH: usize = 16;
const BODY_ROWS: usize = 10;
const LEG_ROWS: usize = 2;

/// Coerce a parsed definition onto the fixed grid: every row exactly
/// `GRID_WIDTH` chars (pad with '.', truncate overflow), `body` exactly
/// `BODY_ROWS`, every leg frame exactly `LEG_ROWS`, and non-zero frame timings.
fn normalize(def: &mut SpriteDefinition) {
    def.body = fit_body(std::mem::take(&mut def.body));
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

/// Force a list of rows to exactly `n` rows of `GRID_WIDTH` chars each, padding
/// or truncating at the BOTTOM (the natural place for leg frames).
fn fit_rows(rows: Vec<String>, n: usize) -> Vec<String> {
    let mut out: Vec<String> = rows.iter().map(|r| fit_row(r)).collect();
    out.truncate(n);
    while out.len() < n {
        out.push(".".repeat(GRID_WIDTH));
    }
    out
}

/// Force `body` to exactly `BODY_ROWS`, but anchored at the BOTTOM: a short body
/// gains transparent rows at the TOP (empty sky above the creature, feet meeting
/// the legs), and an over-tall body drops its TOP rows (usually empty margin).
/// This keeps the creature's feet adjacent to the leg rows instead of floating.
fn fit_body(rows: Vec<String>) -> Vec<String> {
    let mut out: Vec<String> = rows.iter().map(|r| fit_row(r)).collect();
    if out.len() > BODY_ROWS {
        out.drain(0..out.len() - BODY_ROWS);
    }
    while out.len() < BODY_ROWS {
        out.insert(0, ".".repeat(GRID_WIDTH));
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

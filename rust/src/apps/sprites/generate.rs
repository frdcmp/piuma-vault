//! LLM sprite generation in rounds: draft, check, render, look, fix.
//!
//! Round 1 is a draft from the prompt. Each later round shows the model a PNG of
//! its previous take (every pose, on the dark and the light theme background)
//! plus the mechanical problems `checks` found, and asks for a fixed version.
//! It stops after `MAX_ROUNDS`, or earlier once the checks pass and the model
//! says the sprite is done. Every round is kept so the admin can pick any of
//! them; nothing is saved to `sprites` until they do.
//!
//! Jobs live in memory (`GenerationStore`): they are drafts, not data. Progress
//! is announced on the sprites SSE bus (`ResourceAction::Updated`, job id).

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use base64::Engine as _;
use chrono::{DateTime, Duration, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use uuid::Uuid;

use super::checks::{check, Issue};
use super::events::SpritesEventBus;
use super::models::SpriteDefinition;
use super::render::sheet_png;
use crate::apps::agents::models::{ModelRow, ProviderRow};
use crate::apps::agents::providers;
use crate::apps::realtime::ResourceAction;
use crate::db::db::DbPool;

pub const MAX_ROUNDS: usize = 4;
/// Finished jobs are dropped after this long.
const KEEP_FOR_HOURS: i64 = 6;

/// One take: the sprite, what the checks found, and the model's note on it.
#[derive(Debug, Clone, Serialize)]
pub struct Round {
    pub round: usize,
    pub definition: SpriteDefinition,
    pub issues: Vec<Issue>,
    pub notes: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Generation {
    pub id: Uuid,
    pub name: String,
    pub prompt: String,
    pub model: String,
    /// running | done | failed
    pub status: String,
    pub rounds: Vec<Round>,
    pub max_rounds: usize,
    pub error: Option<String>,
    pub started_at: DateTime<Utc>,
    pub finished_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Default)]
pub struct GenerationStore(Arc<Mutex<HashMap<Uuid, Generation>>>);

impl GenerationStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Newest first; finished jobs older than `KEEP_FOR_HOURS` are dropped.
    pub fn list(&self) -> Vec<Generation> {
        let mut map = self.0.lock().unwrap();
        let cutoff = Utc::now() - Duration::hours(KEEP_FOR_HOURS);
        map.retain(|_, g| g.finished_at.map_or(true, |t| t > cutoff));
        let mut out: Vec<Generation> = map.values().cloned().collect();
        out.sort_by(|a, b| b.started_at.cmp(&a.started_at));
        out
    }

    pub fn remove(&self, id: &Uuid) -> bool {
        self.0.lock().unwrap().remove(id).is_some()
    }

    fn insert(&self, g: Generation) {
        self.0.lock().unwrap().insert(g.id, g);
    }

    fn update(&self, id: &Uuid, f: impl FnOnce(&mut Generation)) -> bool {
        match self.0.lock().unwrap().get_mut(id) {
            Some(g) => {
                f(g);
                true
            }
            None => false, // dismissed while running
        }
    }
}

/// The fox from `skills/piuma-sprites/examples/fox.json`, which follows every
/// rule in the prompt. Used only to show the FORMAT.
const FORMAT_EXAMPLE: &str = r##"{
  "palette": {"B":"#e07b2e","D":"#9c4a18","W":"#f6eadb","E":"#2a1d14","N":"#2a1d14"},
  "body": [
    ".D...D..........",".BD.DB..........",".BBBBB......DD..","BEBBBEB....DBBD.",
    "BWBBBWB...DBBBB.","BWWNWWBBBBBBBBB.",".BWWWBBBBBBBBBW.","...BBBBBBBBBBWW.",
    "...BWWWWBBBBB...","...BWWWWBBBBB..."
  ],
  "idleLegs": ["...D.D....D.D...","...D.D....D.D..."],
  "walkLegs": [
    ["...D.D....D.D...","..D...D..D...D.."],
    ["...D.D....D.D...","...D.D....D.D..."],
    ["....DD....DD....","....DD....DD...."],
    ["...D.D....D.D...","...D.D....D.D..."]
  ],
  "walkFrameMs": 120,
  "gallopLegs": [
    ["...DD......DD...","..D..........D.."],
    ["....DD...DD.....",".....D...D......"]
  ],
  "gallopFrameMs": 140
}"##;

const SYSTEM: &str = "You are a pixel-art artist drawing a tiny animated mascot \
for an app. You reply with ONLY a JSON object, no prose and no markdown fences.

THE GRID
16 columns wide, 12 rows tall. Every row is a string of exactly 16 characters. \
'.' is transparent; any other character is a palette code (one uppercase letter) \
mapped to a colour like \"#e07b2e\" in `palette`.
- `body`: exactly 10 rows, the head and torso, shared by every pose.
- `idleLegs`: exactly 2 rows, the legs when standing.
- `walkLegs`: 4 frames of 2 rows each.
- `gallopLegs`: 2 frames of 2 rows each.
- `walkFrameMs` 110-140, `gallopFrameMs` 120-160.
Only the two leg rows change between frames; the body never moves.

HOW IT IS SHOWN
The mascot sits in the app header at 2 screen pixels per cell (the whole sprite \
is 32x24 px), runs in the chat loader at 2 px, and floats on the home screen at \
8 px. The app has a near-black dark theme and a cream light theme. So:
1. FACE LEFT, FACING THE VIEWER. Put a front-facing face (two eyes, a nose or \
muzzle, ears) on the LEFT side of the body and the tail on the right, so the head \
leads when it walks left. The app mirrors it when it walks right.
2. SILHOUETTE FIRST. At 32x24 px only the outline reads. Make the shape say what \
the creature is: ears, snout, tail, body proportions. No symmetric blob.
3. AIR AROUND IT. Keep the top row mostly empty and leave transparent cells around \
the creature. Never fill a body row edge to edge. If the creature is short, the \
empty rows go at the TOP and the creature sits on the legs.
4. VISIBLE ON BOTH THEMES. A colour on the outline must contrast with both \
near-black and cream. Pure black or near-black vanishes on the dark theme; white \
or cream vanishes on the light one. Put light colours inside the shape, edged by \
the body colour, and use dark brown or navy instead of black for dark details.
5. FEW COLOURS. 4 to 7 palette entries: body, a shade, a light belly or face, \
eyes, one accent.
6. LEGS STAY ATTACHED. Every leg pixel touches the body row above it or another \
leg pixel, at least diagonally. Keep feet under the body.
7. WALK = 4-frame diagonal trot: frame 1 swings one diagonal pair (front-left and \
back-right) forward and lifts it (its pixel stays in leg row 1, no foot in leg row \
2), frame 2 is standing, frame 3 swings the other diagonal pair, frame 4 is \
standing.
8. GALLOP = 2 clearly different frames: legs stretched out front and back, then \
gathered under the body.

REPLY FORMAT
{\"done\": false, \"notes\": \"one or two sentences on what you drew or changed\", \
\"sprite\": { ...the sprite... }}

FORMAT EXAMPLE of a sprite (a fox that follows every rule; invent your own \
creature, do not copy its shape or colours):
";

pub struct Started {
    pub id: Uuid,
}

/// Check the default model can do the job, register a job and run it in the
/// background. Errors here are returned to the caller right away.
pub async fn start(
    pool: &DbPool,
    store: &GenerationStore,
    bus: &SpritesEventBus,
    name: String,
    prompt: String,
) -> Result<Started, String> {
    let (model, provider) = default_model(pool).await?;
    if !model.supports_vision {
        return Err(format!(
            "The default chat model ({}) can't see images, and the generator needs to look at its \
             renders. Make a vision model the default on the Agents page.",
            model.display_name
        ));
    }
    let id = Uuid::new_v4();
    store.insert(Generation {
        id,
        name,
        prompt: prompt.clone(),
        model: model.display_name.clone(),
        status: "running".into(),
        rounds: Vec::new(),
        max_rounds: MAX_ROUNDS,
        error: None,
        started_at: Utc::now(),
        finished_at: None,
    });
    bus.publish(ResourceAction::Created, id);

    let (store, bus) = (store.clone(), bus.clone());
    tokio::spawn(async move {
        let result = run(&store, &bus, id, &model, &provider, &prompt).await;
        store.update(&id, |g| {
            g.finished_at = Some(Utc::now());
            match result {
                Ok(()) => g.status = "done".into(),
                Err(e) => {
                    log::error!("sprites: generation {id} failed: {e}");
                    // A failure after a good round still leaves usable takes.
                    g.status = if g.rounds.is_empty() { "failed".into() } else { "done".into() };
                    g.error = Some(e);
                }
            }
        });
        bus.publish(ResourceAction::Updated, id);
    });
    Ok(Started { id })
}

async fn run(
    store: &GenerationStore,
    bus: &SpritesEventBus,
    id: Uuid,
    model: &ModelRow,
    provider: &ProviderRow,
    prompt: &str,
) -> Result<(), String> {
    let system = format!("{SYSTEM}{FORMAT_EXAMPLE}");
    let brief = format!("Draw a mascot sprite of: {prompt}");

    let draft = ask(
        provider,
        model,
        vec![json!({ "role": "system", "content": &system }), json!({ "role": "user", "content": &brief })],
    )
    .await?;
    let Some(mut current_round) = record(store, bus, &id, 1, draft.sprite, draft.notes) else {
        return Ok(()); // dismissed
    };

    for round in 2..=MAX_ROUNDS {
        let png = sheet_png(&current_round.definition)?;
        let image = format!(
            "data:image/png;base64,{}",
            base64::engine::general_purpose::STANDARD.encode(png)
        );
        let problems = if current_round.issues.is_empty() {
            "The automatic checks found no problems.".to_string()
        } else {
            let list: Vec<String> = current_round.issues.iter().map(|i| format!("- {}", i.message)).collect();
            format!("The automatic checks found these problems, fix all of them:\n{}", list.join("\n"))
        };
        let look = format!(
            "{brief}\n\nThis is your current sprite:\n{json}\n\nThe image shows it rendered: the top band is \
             the dark theme, the bottom band the light theme. Panels left to right: GRID (the standing pose with \
             cell lines; the amber line marks where the leg rows start), IDLE, WALK 1-4, GALLOP 1-2.\n\n{problems}\n\n\
             Look at the image as the user would. Does the silhouette clearly read as {prompt} at small size? \
             Does it face left with a front-facing face? Is every part visible on both bands? Do the walk and \
             gallop frames read as motion with attached feet? Then reply with the improved sprite. Set \"done\" \
             to true only if it already looks right and the checks found nothing; then return it unchanged.",
            json = serde_json::to_string(&current_round.definition).unwrap_or_default(),
        );
        let reply = ask(
            provider,
            model,
            vec![
                json!({ "role": "system", "content": &system }),
                json!({ "role": "user", "content": [
                    { "type": "text", "text": look },
                    { "type": "image", "url": image, "media_type": "image/png" }
                ]}),
            ],
        )
        .await?;
        if reply.done && current_round.issues.is_empty() {
            break;
        }
        match record(store, bus, &id, round, reply.sprite, reply.notes) {
            Some(r) => current_round = r,
            None => return Ok(()), // dismissed
        }
    }
    Ok(())
}

/// Store a round on the job and announce it. None if the job was dismissed.
fn record(
    store: &GenerationStore,
    bus: &SpritesEventBus,
    id: &Uuid,
    round: usize,
    definition: SpriteDefinition,
    notes: String,
) -> Option<Round> {
    let r = Round { round, issues: check(&definition), definition, notes };
    let stored = store.update(id, |g| g.rounds.push(r.clone()));
    if stored {
        bus.publish(ResourceAction::Updated, *id);
        Some(r)
    } else {
        None
    }
}

struct Reply {
    done: bool,
    notes: String,
    sprite: SpriteDefinition,
}

/// One model call → the reply envelope with a validated, grid-normalized sprite.
async fn ask(provider: &ProviderRow, model: &ModelRow, messages: Vec<Value>) -> Result<Reply, String> {
    // Generous budget: the JSON is sizeable and the model may be a reasoning
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
    .map_err(|e| format!("the model call failed: {e}"))?;
    let json_str = extract_json(&raw).ok_or("the model did not return a JSON object")?;
    let v: Value = serde_json::from_str(json_str).map_err(|e| format!("the model returned malformed JSON: {e}"))?;
    let sprite_value = v.get("sprite").cloned().ok_or("the model's reply has no \"sprite\"")?;
    let mut sprite: SpriteDefinition =
        serde_json::from_value(sprite_value).map_err(|e| format!("the model returned a malformed sprite: {e}"))?;
    // Models drift off the grid contract (a row a char too long, 9 body rows
    // instead of 10). Repair to the canonical shape; validate() is the backstop.
    normalize(&mut sprite);
    sprite.validate()?;
    Ok(Reply {
        done: v.get("done").and_then(|d| d.as_bool()).unwrap_or(false),
        notes: v.get("notes").and_then(|n| n.as_str()).unwrap_or("").trim().to_string(),
        sprite,
    })
}

async fn default_model(pool: &DbPool) -> Result<(ModelRow, ProviderRow), String> {
    let model: ModelRow = sqlx::query_as("SELECT * FROM db_llm_models WHERE is_default AND enabled LIMIT 1")
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("No default chat model is configured. Set one on the Agents page.")?;
    let provider: ProviderRow = sqlx::query_as("SELECT * FROM db_llm_providers WHERE id = $1")
        .bind(model.provider_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .ok_or("The default model's provider was not found.")?;
    if !providers::supported(&provider.kind) || provider.api_key.trim().is_empty() {
        return Err("The default model's provider is not configured.".into());
    }
    Ok((model, provider))
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

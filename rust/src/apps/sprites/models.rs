use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::FromRow;
use std::collections::HashMap;

/// A mascot sprite definition — palette + poses. Stored as JSONB in `sprites`.
/// A pose is an array of equal-length pixel-code strings; each character maps to
/// a color via `palette` (unknown code = transparent). The top `body` rows are
/// shared by every pose; only the two leg rows change per pose.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpriteDefinition {
    pub palette: HashMap<String, String>,
    pub body: Vec<String>,
    #[serde(rename = "idleLegs")]
    pub idle_legs: Vec<String>,
    #[serde(rename = "walkLegs")]
    pub walk_legs: Vec<Vec<String>>,
    #[serde(rename = "walkFrameMs")]
    pub walk_frame_ms: u32,
    #[serde(rename = "gallopLegs")]
    pub gallop_legs: Vec<Vec<String>>,
    #[serde(rename = "gallopFrameMs")]
    pub gallop_frame_ms: u32,
}

impl SpriteDefinition {
    /// Reject malformed grids before they reach the DB: a non-empty palette, a
    /// non-empty body, two-row leg frames, at least one walk/gallop frame, and a
    /// single consistent width across every row.
    pub fn validate(&self) -> Result<(), String> {
        if self.palette.is_empty() {
            return Err("palette is empty".into());
        }
        if self.body.is_empty() {
            return Err("body has no rows".into());
        }
        let width = self.body[0].len();
        if width == 0 {
            return Err("body rows are empty".into());
        }
        if self.idle_legs.len() != 2 {
            return Err("idleLegs must be exactly 2 rows".into());
        }
        if self.walk_legs.is_empty() {
            return Err("walkLegs must have at least one frame".into());
        }
        if self.gallop_legs.is_empty() {
            return Err("gallopLegs must have at least one frame".into());
        }
        if self.walk_frame_ms == 0 || self.gallop_frame_ms == 0 {
            return Err("frame durations must be greater than zero".into());
        }

        // Every row across body + all leg frames must share one width.
        let mut rows: Vec<&String> = self.body.iter().chain(self.idle_legs.iter()).collect();
        for frame in self.walk_legs.iter().chain(self.gallop_legs.iter()) {
            if frame.len() != 2 {
                return Err("each leg frame must be exactly 2 rows".into());
            }
            rows.extend(frame.iter());
        }
        if rows.iter().any(|r| r.len() != width) {
            return Err(format!("all rows must be {} columns wide", width));
        }
        Ok(())
    }
}

/// Row shape read from `sprites`.
#[derive(Debug, FromRow)]
pub struct SpriteRow {
    pub key: String,
    pub name: String,
    pub definition: Value,
    pub is_builtin: bool,
}

/// Admin list item — full definition plus whether it's the active mascot.
#[derive(Debug, Serialize)]
pub struct SpriteResponse {
    pub key: String,
    pub name: String,
    pub definition: Value,
    pub is_builtin: bool,
    pub active: bool,
}

/// Public payload for the currently-active mascot.
#[derive(Debug, Serialize)]
pub struct ActiveSpriteResponse {
    pub key: String,
    pub name: String,
    pub definition: Value,
}

#[derive(Debug, Deserialize)]
pub struct CreateSpriteRequest {
    pub key: String,
    pub name: String,
    pub definition: SpriteDefinition,
}

#[derive(Debug, Deserialize)]
pub struct UpdateSpriteRequest {
    pub name: Option<String>,
    pub definition: Option<SpriteDefinition>,
}

#[derive(Debug, Deserialize)]
pub struct SetActiveRequest {
    pub key: String,
}

/// Kick off async AI generation. The LLM call is too slow to hold an HTTP
/// request open, so the handler validates these, spawns the work, and returns
/// 202; the finished sprite is saved under `key`/`name` and announced over SSE.
#[derive(Debug, Deserialize)]
pub struct GenerateSpriteRequest {
    pub key: String,
    pub name: String,
    pub prompt: String,
}

#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
}

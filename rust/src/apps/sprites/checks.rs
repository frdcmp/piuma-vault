//! Mechanical checks on a sprite definition: things code can measure exactly,
//! so the generator can tell the model precisely what to fix (and the UI can
//! show it) instead of hoping the model notices on its own.
//!
//! `validate()` (models.rs) already guarantees the grid shape; these are the
//! quality problems that still pass it.

use std::collections::HashSet;

use serde::Serialize;

use super::models::SpriteDefinition;
use super::render::parse_hex;

/// Theme backgrounds the sprite must stay visible on (mono and paper).
const BACKGROUNDS: [(&str, [u8; 3]); 2] = [("dark", [0x0e, 0x0f, 0x12]), ("light", [0xf3, 0xef, 0xe6])];
/// Below this WCAG contrast ratio an outline colour all but disappears.
const MIN_CONTRAST: f64 = 1.4;

#[derive(Debug, Clone, Serialize)]
pub struct Issue {
    pub message: String,
}

fn issue(message: String) -> Issue {
    Issue { message }
}

fn filled(c: char) -> bool {
    c != '.'
}

pub fn check(def: &SpriteDefinition) -> Vec<Issue> {
    let mut out = Vec::new();
    let all_rows: Vec<&String> = def
        .body
        .iter()
        .chain(def.idle_legs.iter())
        .chain(def.walk_legs.iter().flatten())
        .chain(def.gallop_legs.iter().flatten())
        .collect();

    // Codes used without a colour (render as holes) and colours never used.
    let used: HashSet<String> = all_rows
        .iter()
        .flat_map(|r| r.chars())
        .filter(|c| filled(*c))
        .map(|c| c.to_string())
        .collect();
    let mut missing: Vec<&String> = used.iter().filter(|c| !def.palette.contains_key(*c)).collect();
    missing.sort();
    if !missing.is_empty() {
        out.push(issue(format!(
            "codes {missing:?} have no palette colour, so they render as holes"
        )));
    }
    let mut unused: Vec<&String> = def.palette.keys().filter(|c| !used.contains(*c)).collect();
    unused.sort();
    if !unused.is_empty() {
        out.push(issue(format!("palette codes {unused:?} are never used")));
    }

    // A row filled edge to edge reads as a wall or a shelf, not a creature.
    for (i, row) in def.body.iter().enumerate() {
        if !row.is_empty() && row.chars().all(filled) {
            out.push(issue(format!(
                "body row {} fills the whole width; leave transparent space at the sides",
                i + 1
            )));
        }
    }

    // Leg pixels touching nothing read as stray dirt, not feet.
    let mut frames: Vec<(String, &Vec<String>)> = vec![("idleLegs".into(), &def.idle_legs)];
    frames.extend(def.walk_legs.iter().enumerate().map(|(i, f)| (format!("walkLegs[{i}]"), f)));
    frames.extend(def.gallop_legs.iter().enumerate().map(|(i, f)| (format!("gallopLegs[{i}]"), f)));
    if let Some(last_body) = def.body.last() {
        for (name, legs) in &frames {
            for (r, c) in floating(last_body, legs) {
                out.push(issue(format!(
                    "{name}: the leg pixel at row {}, column {} touches nothing; connect it to the body or another leg pixel",
                    r + 11,
                    c + 1
                )));
            }
        }
    }

    // Animation that doesn't move.
    if def.walk_legs.iter().all(|f| f == &def.idle_legs) {
        out.push(issue(
            "every walk frame is the same as the standing legs, so the walk shows no motion".into(),
        ));
    }
    if def.gallop_legs.len() > 1 && def.gallop_legs.windows(2).all(|w| w[0] == w[1]) {
        out.push(issue("the gallop frames are identical, so the gallop shows no motion".into()));
    }

    // Outline colours that vanish on a theme background.
    let outline = outline_codes(def);
    let mut codes: Vec<&String> = outline.iter().collect();
    codes.sort();
    for code in codes {
        let Some(rgb) = def.palette.get(code).and_then(|h| parse_hex(h)) else {
            continue;
        };
        for (theme, bg) in BACKGROUNDS {
            let ratio = contrast(rgb, bg);
            if ratio < MIN_CONTRAST {
                out.push(issue(format!(
                    "colour {code} ({}) is on the outline and nearly invisible on the {theme} theme (contrast {ratio:.2}); darken/lighten it or edge it with another colour",
                    def.palette[code]
                )));
            }
        }
    }
    out
}

/// (leg row, column) of leg pixels with no filled 8-way neighbour in the last
/// body row or the leg rows.
fn floating(last_body: &str, legs: &[String]) -> Vec<(usize, usize)> {
    let grid: Vec<Vec<char>> = std::iter::once(last_body)
        .chain(legs.iter().map(|s| s.as_str()))
        .map(|r| r.chars().collect())
        .collect();
    let at = |r: isize, c: isize| -> bool {
        r >= 0
            && (r as usize) < grid.len()
            && c >= 0
            && (c as usize) < grid[r as usize].len()
            && filled(grid[r as usize][c as usize])
    };
    let mut out = Vec::new();
    for r in 1..grid.len() {
        for c in 0..grid[r].len() {
            if !filled(grid[r][c]) {
                continue;
            }
            let (ri, ci) = (r as isize, c as isize);
            let touches = (-1..=1).any(|dr| (-1..=1).any(|dc| (dr, dc) != (0, 0) && at(ri + dr, ci + dc)));
            if !touches {
                out.push((r - 1, c));
            }
        }
    }
    out
}

/// Codes of filled pixels next to a transparent cell (or the grid edge) in the
/// idle pose: the colours that meet the theme background.
fn outline_codes(def: &SpriteDefinition) -> HashSet<String> {
    let rows: Vec<Vec<char>> = def
        .body
        .iter()
        .chain(def.idle_legs.iter())
        .map(|r| r.chars().collect())
        .collect();
    let empty = |r: isize, c: isize| -> bool {
        r < 0
            || r as usize >= rows.len()
            || c < 0
            || c as usize >= rows[r as usize].len()
            || !filled(rows[r as usize][c as usize])
    };
    let mut out = HashSet::new();
    for (r, row) in rows.iter().enumerate() {
        for (c, ch) in row.iter().enumerate() {
            let (ri, ci) = (r as isize, c as isize);
            if filled(*ch) && [(-1, 0), (1, 0), (0, -1), (0, 1)].iter().any(|(dr, dc)| empty(ri + dr, ci + dc)) {
                out.insert(ch.to_string());
            }
        }
    }
    out
}

/// WCAG contrast ratio between two sRGB colours.
fn contrast(a: [u8; 3], b: [u8; 3]) -> f64 {
    let lum = |c: [u8; 3]| {
        let ch = |v: u8| {
            let s = v as f64 / 255.0;
            if s <= 0.03928 { s / 12.92 } else { ((s + 0.055) / 1.055).powf(2.4) }
        };
        0.2126 * ch(c[0]) + 0.7152 * ch(c[1]) + 0.0722 * ch(c[2])
    };
    let (la, lb) = (lum(a), lum(b));
    let (hi, lo) = if la > lb { (la, lb) } else { (lb, la) };
    (hi + 0.05) / (lo + 0.05)
}

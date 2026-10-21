//! Draw a sprite as a PNG pose sheet, so a vision model can look at what it
//! drew instead of reading a grid of letters.
//!
//! Layout (same as `skills/piuma-sprites/scripts/sprite.py render`): one row of
//! panels per band, a dark band (the mono theme background) on top and a light
//! band (the paper theme background) below. Panels left to right: the idle pose
//! with a cell grid (the amber line marks where the leg rows start), then idle,
//! each walk frame and each gallop frame. Every panel has a small pixel-font
//! label under it.

use super::models::SpriteDefinition;

const SCALE: u32 = 8; // pixels per sprite cell
const PAD: u32 = 16;
const LABEL_H: u32 = 12;
const FONT_PX: u32 = 2; // pixels per font dot
const LEG_ROWS: usize = 2;

const DARK_BG: [u8; 3] = [0x0e, 0x0f, 0x12];
const LIGHT_BG: [u8; 3] = [0xf3, 0xef, 0xe6];
const DARK_TEXT: [u8; 3] = [0x8a, 0x93, 0xa3];
const LIGHT_TEXT: [u8; 3] = [0x6b, 0x65, 0x5a];
const GRID_LINE: [u8; 3] = [0x3c, 0x42, 0x50];
const LEG_LINE: [u8; 3] = [0xc8, 0x8a, 0x2a];

/// Every pose of the sprite as (label, rows).
pub fn poses(def: &SpriteDefinition) -> Vec<(String, Vec<String>)> {
    let with = |legs: &[String]| def.body.iter().chain(legs.iter()).cloned().collect::<Vec<_>>();
    let mut out = vec![("IDLE".to_string(), with(&def.idle_legs))];
    for (i, f) in def.walk_legs.iter().enumerate() {
        out.push((format!("WALK {}", i + 1), with(f)));
    }
    for (i, f) in def.gallop_legs.iter().enumerate() {
        out.push((format!("GALLOP {}", i + 1), with(f)));
    }
    out
}

struct Canvas {
    w: u32,
    h: u32,
    px: Vec<u8>,
}

impl Canvas {
    fn new(w: u32, h: u32, bg: [u8; 3]) -> Self {
        let mut px = Vec::with_capacity((w * h * 3) as usize);
        for _ in 0..w * h {
            px.extend_from_slice(&bg);
        }
        Self { w, h, px }
    }

    fn rect(&mut self, x0: u32, y0: u32, w: u32, h: u32, c: [u8; 3]) {
        for y in y0..(y0 + h).min(self.h) {
            for x in x0..(x0 + w).min(self.w) {
                let i = ((y * self.w + x) * 3) as usize;
                self.px[i..i + 3].copy_from_slice(&c);
            }
        }
    }

    fn pose(&mut self, rows: &[String], palette: &std::collections::HashMap<String, String>, x0: u32, y0: u32) {
        for (y, row) in rows.iter().enumerate() {
            for (x, code) in row.chars().enumerate() {
                if let Some(c) = palette.get(&code.to_string()).and_then(|h| parse_hex(h)) {
                    self.rect(x0 + x as u32 * SCALE, y0 + y as u32 * SCALE, SCALE, SCALE, c);
                }
            }
        }
    }

    fn grid(&mut self, cols: u32, rows: u32, x0: u32, y0: u32) {
        for x in 0..=cols {
            self.rect(x0 + x * SCALE, y0, 1, rows * SCALE, GRID_LINE);
        }
        for y in 0..=rows {
            let colour = if y == rows - LEG_ROWS as u32 { LEG_LINE } else { GRID_LINE };
            self.rect(x0, y0 + y * SCALE, cols * SCALE, 1, colour);
        }
    }

    fn text(&mut self, s: &str, x0: u32, y0: u32, c: [u8; 3]) {
        let mut x = x0;
        for ch in s.chars() {
            if let Some(g) = glyph(ch) {
                for (gy, line) in g.iter().enumerate() {
                    for gx in 0..3 {
                        if line & (0b100 >> gx) != 0 {
                            self.rect(x + gx * FONT_PX, y0 + gy as u32 * FONT_PX, FONT_PX, FONT_PX, c);
                        }
                    }
                }
            }
            x += 4 * FONT_PX;
        }
    }
}

/// The pose sheet as PNG bytes.
pub fn sheet_png(def: &SpriteDefinition) -> Result<Vec<u8>, String> {
    let poses = poses(def);
    let cols = def.body.first().map(|r| r.chars().count()).unwrap_or(0) as u32;
    let rows = (def.body.len() + LEG_ROWS) as u32;
    if cols == 0 {
        return Err("sprite has no columns".into());
    }
    let (pw, ph) = (cols * SCALE, rows * SCALE);
    let panels = poses.len() as u32 + 1;
    let band_h = ph + PAD * 2 + LABEL_H;
    let w = panels * (pw + PAD) + PAD;
    let mut c = Canvas::new(w, band_h * 2, DARK_BG);
    c.rect(0, band_h, w, band_h, LIGHT_BG);

    for (band, text) in [(0u32, DARK_TEXT), (1, LIGHT_TEXT)] {
        let y0 = band * band_h + PAD;
        let label_y = y0 + ph + 4;
        let mut x = PAD;
        c.pose(&poses[0].1, &def.palette, x, y0);
        c.grid(cols, rows, x, y0);
        c.text("GRID", x, label_y, text);
        for (label, pose_rows) in &poses {
            x += pw + PAD;
            c.pose(pose_rows, &def.palette, x, y0);
            c.text(label, x, label_y, text);
        }
    }
    encode(&c)
}

fn encode(c: &Canvas) -> Result<Vec<u8>, String> {
    let mut out = Vec::new();
    {
        let mut enc = png::Encoder::new(&mut out, c.w, c.h);
        enc.set_color(png::ColorType::Rgb);
        enc.set_depth(png::BitDepth::Eight);
        let mut writer = enc.write_header().map_err(|e| e.to_string())?;
        writer.write_image_data(&c.px).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

/// `#rgb` / `#rrggbb` → RGB.
pub fn parse_hex(h: &str) -> Option<[u8; 3]> {
    let h = h.trim().trim_start_matches('#');
    let full: String = match h.len() {
        3 => h.chars().flat_map(|c| [c, c]).collect(),
        6 => h.to_string(),
        _ => return None,
    };
    let v = |i: usize| u8::from_str_radix(&full[i..i + 2], 16).ok();
    Some([v(0)?, v(2)?, v(4)?])
}

/// 3x5 pixel font for the panel labels (rows top to bottom, 3 bits each).
fn glyph(ch: char) -> Option<[u8; 5]> {
    Some(match ch {
        'A' => [0b010, 0b101, 0b111, 0b101, 0b101],
        'D' => [0b110, 0b101, 0b101, 0b101, 0b110],
        'E' => [0b111, 0b100, 0b110, 0b100, 0b111],
        'G' => [0b011, 0b100, 0b101, 0b101, 0b011],
        'I' => [0b111, 0b010, 0b010, 0b010, 0b111],
        'K' => [0b101, 0b101, 0b110, 0b101, 0b101],
        'L' => [0b100, 0b100, 0b100, 0b100, 0b111],
        'O' => [0b010, 0b101, 0b101, 0b101, 0b010],
        'P' => [0b110, 0b101, 0b110, 0b100, 0b100],
        'R' => [0b110, 0b101, 0b110, 0b101, 0b101],
        'W' => [0b101, 0b101, 0b101, 0b111, 0b101],
        '0' => [0b111, 0b101, 0b101, 0b101, 0b111],
        '1' => [0b010, 0b110, 0b010, 0b010, 0b111],
        '2' => [0b110, 0b001, 0b010, 0b100, 0b111],
        '3' => [0b110, 0b001, 0b010, 0b001, 0b110],
        '4' => [0b101, 0b101, 0b111, 0b001, 0b001],
        '5' => [0b111, 0b100, 0b110, 0b001, 0b110],
        '6' => [0b011, 0b100, 0b110, 0b101, 0b010],
        '7' => [0b111, 0b001, 0b010, 0b010, 0b010],
        '8' => [0b010, 0b101, 0b010, 0b101, 0b010],
        '9' => [0b010, 0b101, 0b011, 0b001, 0b110],
        _ => return None, // space and anything else: a blank cell
    })
}

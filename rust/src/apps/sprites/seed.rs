//! Idempotent boot seed for the built-in mascots (Piuma / Bubu / lizard).
//! Seeds only when the `sprites` table is empty, so user edits and deletions
//! persist across reboots. After first boot the DB is the source of truth.
//! Pigeon (the Inbox's agent) is the exception: put back whenever it's missing,
//! and locked against edits and deletion.

use super::handlers::{ACTIVE_KEY, DEFAULT_KEY, PIGEON_KEY};
use crate::apps::settings::store;
use crate::db::db::DbPool;

const PIUMA: &str = r##"{
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

const BUBU: &str = r##"{
  "palette": {"B":"#8d93a0","W":"#eceef2","M":"#eceef2","N":"#ff8fab","Y":"#7ee787","P":"#ffb3c6","T":"#e76f8a","C":"#39c5bb"},
  "body": [
    "....B...B....B..","...BPB.BPB...B..","...BBBBBBB...B..","...BYBBBYB...B..",
    "...BBMNMBBBBBB..","...BMMTMBBBBBBB.","...BBBBBBBBBBBB.","...CCCCCCCCCCC..",
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

const LIZARD: &str = r##"{
  "palette": {"B":"#5fb878","D":"#357a4b","W":"#e3f2b0","M":"#7fce95","N":"#1f3a29","Y":"#ffd23f","T":"#ff5a5f"},
  "body": [
    "................","....D.D.D.D.....","...BBBBBBBB.....","..BBYBBBBBBB.DD.",
    "MMBBBBBBBBBBBDDD","TBBNBBBBBBBBB.D.","..BBBBBBBBBBB...","...BWWWWWWWWBB..",
    "...BWWWWWWWWBB..","...BBBBBBBBBBB.."
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

/// Pigeon, the Inbox's agent: always there, never edited or deleted (`PIGEON_KEY`).
const PIGEON: &str = r##"{"palette":{"G":"#9aa5b8","V":"#7f8ba2","D":"#4f5a6e","H":"#7a879e","I":"#3fae8c","P":"#9a68c0","K":"#3a3f4c","O":"#ff8a3d","A":"#b39a62","L":"#f7f2e6","R":"#d23c3c","W":"#cfd6e2","F":"#e8798a"},"body":["................","......HHH.......",".....HHHHH......","AAAAKHOHHH......","ALRA.HIIPP......","AAAA.PIIGGGGG...",".....GPGGVVVVDDD","....WGGGVDDDVDD.","....WWGGVVVDDD..",".....WWGGGGGG..."],"idleLegs":[".......F..F.....","......FF.FF....."],"walkLegs":[[".......F...F....","......FF..FF...."],[".......F..F.....","......FF.FF....."],["......F..F......",".....FF.FF......"],[".......F..F.....","......FF.FF....."]],"walkFrameMs":120,"gallopLegs":[["......F.....F...",".....FF.....FF.."],[".........FF.....","........FFFF...."]],"gallopFrameMs":140}"##;

const BUILTINS: &[(&str, &str, &str)] = &[
    ("piuma", "Piuma", PIUMA),
    ("bubu", "Bubu", BUBU),
    ("lizard", "Lizard", LIZARD),
];

pub async fn seed_builtins(pool: &DbPool) {
    ensure_pigeon(pool).await;
    let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM sprites")
        .fetch_one(pool)
        .await
        .unwrap_or(0);
    if count > 0 {
        return;
    }

    for (key, name, json) in BUILTINS {
        let def: serde_json::Value = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(e) => {
                log::error!("sprites seed: bad JSON for {key}: {e}");
                continue;
            }
        };
        let res = sqlx::query(
            "INSERT INTO sprites (key, name, definition, is_builtin) VALUES ($1, $2, $3, TRUE) \
             ON CONFLICT (key) DO NOTHING",
        )
        .bind(key)
        .bind(name)
        .bind(&def)
        .execute(pool)
        .await;
        if let Err(e) = res {
            log::error!("sprites seed: insert {key} failed: {e:?}");
        }
    }

    // Point the active selection at the default mascot if nothing is set yet.
    if store::get(pool, ACTIVE_KEY).await.is_none() {
        let _ = store::set(pool, ACTIVE_KEY, DEFAULT_KEY).await;
    }
    println!("🐾 Seeded built-in sprites (piuma, bubu, lizard)");
}

/// Pigeon's sprite, put back whenever it's missing: the Inbox draws it.
async fn ensure_pigeon(pool: &DbPool) {
    let def: serde_json::Value = serde_json::from_str(PIGEON).expect("Pigeon's sprite is JSON");
    let res = sqlx::query("INSERT INTO sprites (key, name, definition, is_builtin) VALUES ($1, 'Pigeon', $2, TRUE) ON CONFLICT (key) DO NOTHING")
        .bind(PIGEON_KEY)
        .bind(&def)
        .execute(pool)
        .await;
    if let Err(e) = res {
        log::error!("sprites seed: insert {PIGEON_KEY} failed: {e:?}");
    }
}

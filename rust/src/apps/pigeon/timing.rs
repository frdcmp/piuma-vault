//! How long Pigeon waits around an auto reply, the user's own (the app's and the Inbox's Reply
//! timing): kept in `db_pigeon_settings` (key `pace`), what they never set from the defaults below.
//!
//!   - wait     for them to finish writing: the triage comes this long after their last message
//!   - read     the pause before "typing…" (what they sent shows read at its start)
//!   - typing   at `chars_per_sec`, kept within `typing` (`pace`: in bursts, with breaks)
//!   - cold     the first reply in a quiet chat (nobody on the user's side wrote there for
//!              `quiet_minutes`) lands this long after their last message
//!   - stay out after the user writes in a chat themselves, Pigeon doesn't answer there for
//!              `stay_out_minutes`
//!
//! The pacing before a reply (read, typing, cold) stays under `MAX_PACING`: a triage holds its
//! conversation for five minutes (`triage`), and one still pacing past that would run again.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};

use crate::db::db::DbPool;

const KEY: &str = "pace";
/// The pacing before a reply, at most (seconds): the triage's five minutes, less the writing.
pub const MAX_PACING: f64 = 240.0;
/// One burst of "typing…" at least, and a break between two at most (`pace`).
pub const BURST_MIN: f64 = 3.0;
pub const BREAK_MAX: f64 = 2.5;

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub struct Timing {
    /// for them to finish writing (seconds)
    pub wait_secs: f64,
    /// the pause before "typing…" (seconds, from–to)
    pub read_secs: [f64; 2],
    /// typing speed on a phone
    pub chars_per_sec: f64,
    /// the whole typing, bursts and breaks aside (seconds, from–to)
    pub typing_secs: [f64; 2],
    /// the first reply in a quiet chat lands this long after their last message (seconds, from–to)
    pub cold_secs: [f64; 2],
    /// a chat is quiet when nobody on the user's side wrote there for this long (minutes)
    pub quiet_minutes: f64,
    /// after the user writes in a chat, Pigeon stays out of it this long (minutes)
    pub stay_out_minutes: f64,
}

/// What each value may be: (field, lowest, highest).
pub const LIMITS: [(&str, f64, f64); 7] = [
    ("wait_secs", 5.0, 120.0),
    ("read_secs", 0.0, 60.0),
    ("chars_per_sec", 2.0, 15.0),
    ("typing_secs", 1.0, 120.0),
    ("cold_secs", 0.0, 240.0),
    ("quiet_minutes", 1.0, 120.0),
    ("stay_out_minutes", 0.0, 120.0),
];

impl Timing {
    /// Pigeon's own, `wait` from the server's setting (PIGEON_TRIAGE_DEBOUNCE_SECS).
    pub fn defaults(wait: Duration) -> Timing {
        Timing {
            wait_secs: wait.as_secs_f64(),
            read_secs: [3.0, 8.0],
            chars_per_sec: 6.0,
            typing_secs: [3.0, 45.0],
            cold_secs: [35.0, 70.0],
            quiet_minutes: 15.0,
            stay_out_minutes: 10.0,
        }
    }

    pub fn wait(&self) -> Duration {
        Duration::from_secs_f64(self.wait_secs)
    }

    /// The longest the pacing before a reply can take: the read pause and the typing with every
    /// break it can have, or the landing in a quiet chat.
    pub fn longest_pacing(&self) -> f64 {
        let typing = self.typing_secs[1] * (1.0 + BREAK_MAX / BURST_MIN);
        (self.read_secs[1] + typing).max(self.cold_secs[1])
    }

    /// Why these can't be kept, in the user's words; None: they can.
    pub fn check(&self) -> Option<String> {
        let values: [(&str, &[f64]); 7] = [
            ("wait_secs", &[self.wait_secs]),
            ("read_secs", &self.read_secs),
            ("chars_per_sec", &[self.chars_per_sec]),
            ("typing_secs", &self.typing_secs),
            ("cold_secs", &self.cold_secs),
            ("quiet_minutes", &[self.quiet_minutes]),
            ("stay_out_minutes", &[self.stay_out_minutes]),
        ];
        for ((name, vs), (_, lo, hi)) in values.iter().zip(LIMITS) {
            if vs.iter().any(|v| !v.is_finite() || *v < lo || *v > hi) {
                return Some(format!("{name}: from {lo} to {hi}"));
            }
            if vs.len() == 2 && vs[0] > vs[1] {
                return Some(format!("{name}: the first can't be more than the second"));
            }
        }
        let longest = self.longest_pacing();
        if longest > MAX_PACING {
            return Some(format!(
                "Pigeon could wait up to {longest:.0} s before a reply goes: at most {MAX_PACING:.0} s (shorten the typing, the reading pause or the quiet chat's landing)"
            ));
        }
        None
    }
}

/// The user's timing: what they set over the defaults (a value they never set, or one that no
/// longer fits, is the default's).
pub async fn get(pool: &DbPool, user: &str, wait: Duration) -> anyhow::Result<Timing> {
    let defaults = Timing::defaults(wait);
    let stored: Option<Json> = sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = $2")
        .bind(user)
        .bind(KEY)
        .fetch_optional(pool)
        .await?;
    let Some(Json::Object(stored)) = stored else { return Ok(defaults) };
    let mut merged = json!(defaults);
    for (k, v) in stored {
        merged[k] = v;
    }
    Ok(serde_json::from_value::<Timing>(merged).ok().filter(|t| t.check().is_none()).unwrap_or(defaults))
}

/// Keep the user's timing (checked); None: back to the defaults.
pub async fn set(pool: &DbPool, user: &str, timing: Option<&Timing>) -> anyhow::Result<()> {
    match timing {
        Some(t) => {
            if let Some(why) = t.check() {
                anyhow::bail!(why);
            }
            sqlx::query(
                "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            )
            .bind(user)
            .bind(KEY)
            .bind(json!(t))
            .execute(pool)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(KEY).execute(pool).await?;
        }
    }
    Ok(())
}

/// The timing of the user whose conversation it is.
pub async fn of_conversation(pool: &DbPool, conversation: uuid::Uuid, wait: Duration) -> anyhow::Result<Timing> {
    let user: Option<String> = sqlx::query_scalar("SELECT user_id FROM db_pigeon_conversations WHERE id = $1").bind(conversation).fetch_optional(pool).await?;
    match user {
        Some(u) => get(pool, &u, wait).await,
        None => Ok(Timing::defaults(wait)),
    }
}

/// For the settings screens: the user's, the defaults, what each may be, and the pacing's cap.
pub fn view(timing: &Timing, wait: Duration) -> Json {
    let limits: serde_json::Map<String, Json> = LIMITS.iter().map(|(k, lo, hi)| (k.to_string(), json!([lo, hi]))).collect();
    json!({
        "values": timing,
        "defaults": Timing::defaults(wait),
        "limits": limits,
        "max_pacing": MAX_PACING,
        "burst_min": BURST_MIN,
        "break_max": BREAK_MAX,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_defaults_fit_and_bad_values_are_said() {
        let d = Timing::defaults(Duration::from_secs(20));
        assert_eq!(d.check(), None);
        assert!(d.longest_pacing() <= MAX_PACING);
        let t = Timing { read_secs: [9.0, 3.0], ..d };
        assert!(t.check().unwrap().starts_with("read_secs"));
        let t = Timing { wait_secs: 2.0, ..d };
        assert!(t.check().unwrap().starts_with("wait_secs"));
        // every value within its limits, but the typing too long altogether
        let t = Timing { typing_secs: [3.0, 120.0], read_secs: [30.0, 60.0], ..d };
        assert!(t.check().unwrap().contains("at most 240"), "{:?}", t.check());
    }
}

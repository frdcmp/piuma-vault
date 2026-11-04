//! How an auto reply goes out like a person writing it, on channels that show "typing…"
//! (WhatsApp, Instagram). The reply is written first, unseen (the user reading their message); then:
//!
//!   - a pause before "typing…", 3–8 s (reading it); in a new chat (nobody on the user's side wrote
//!     there in the last 15 minutes) longer, so the reply lands 35–70 s after their last message
//!   - "typing…" in bursts, with short breaks where it goes off, for about as long as a person
//!     takes to type the reply on a phone (3–15 s); it ends with the reply sent
//!
//! When they write again meanwhile, or the user writes there themselves, it stops and nothing goes
//! out: the next round answers all of it (or the user did).

use std::time::Duration;

use chrono::{DateTime, Utc};
use rand::Rng;
use uuid::Uuid;

use crate::apps::pigeon::connectors::Connector;
use crate::apps::pigeon::state::State;

/// Someone on the user's side wrote this recently: the chat is flowing, no pause first.
const FLOWING_MINUTES: i32 = 15;
/// Before "typing…" starts, always (seconds, at random).
const READ_SECS: (f64, f64) = (3.0, 8.0);
/// A new chat: the reply lands this long after their last message (seconds, at random).
const COLD_SECS: (f64, f64) = (35.0, 70.0);
/// Typing speed on a phone.
const CHARS_PER_SEC: f64 = 6.0;
/// The whole typing, bursts and breaks.
const TYPING_SECS: (f64, f64) = (3.0, 15.0);
/// One burst of "typing…", and a break between two.
const BURST_SECS: (f64, f64) = (3.0, 7.0);
const BREAK_SECS: (f64, f64) = (1.0, 2.5);
/// How often a wait looks for a new message.
const CHECK_SECS: f64 = 1.0;

/// The bursts of "typing…" for a reply this long: (typing, then off) each; the last one's off is 0
/// (the reply goes out at its end).
pub fn bursts(chars: usize, rng: &mut impl Rng) -> Vec<(f64, f64)> {
    let total = (chars as f64 / CHARS_PER_SEC * rng.gen_range(0.75..1.25)).clamp(TYPING_SECS.0, TYPING_SECS.1);
    let mut out = Vec::new();
    let mut left = total;
    while left > 0.0 {
        let on = rng.gen_range(BURST_SECS.0..BURST_SECS.1).min(left);
        left -= on;
        // a remainder too short for a burst of its own goes to this one
        if left < BURST_SECS.0 {
            out.push((on + left, 0.0));
            break;
        }
        out.push((on, rng.gen_range(BREAK_SECS.0..BREAK_SECS.1)));
    }
    out
}

/// Whether they (or the user) wrote in the conversation after `since`, and who.
async fn interrupted(st: &State, conversation: Uuid, since: DateTime<Utc>) -> anyhow::Result<Option<&'static str>> {
    let who: Option<String> = sqlx::query_scalar(
        "SELECT author FROM db_pigeon_items WHERE conversation_id = $1 AND created_at > $2 AND author IN ('them', 'me') ORDER BY created_at DESC LIMIT 1",
    )
    .bind(conversation)
    .bind(since)
    .fetch_optional(&st.pool)
    .await?;
    Ok(who.map(|w| if w == "me" { "you wrote there" } else { "they wrote again" }))
}

/// Waits `secs`, looking for a new message every second.
async fn wait(st: &State, conversation: Uuid, since: DateTime<Utc>, secs: f64) -> anyhow::Result<Option<&'static str>> {
    let mut left = secs;
    while left > 0.0 {
        let step = left.min(CHECK_SECS);
        tokio::time::sleep(Duration::from_secs_f64(step)).await;
        left -= step;
        if let Some(why) = interrupted(st, conversation, since).await? {
            return Ok(Some(why));
        }
    }
    Ok(None)
}

/// The pause and the typing before an auto reply of `text` goes out. `since`: what came in after
/// it is new (the reply wasn't written for it). Ok(None): send it now ("typing…" still on); Some:
/// why not (it's taken off).
pub async fn before_send(st: &State, c: &dyn Connector, conversation: Uuid, text: &str, since: DateTime<Utc>) -> anyhow::Result<Option<&'static str>> {
    let flowing: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_items WHERE conversation_id = $1 AND author IN ('me', 'pigeon') AND at > NOW() - make_interval(mins => $2))",
    )
    .bind(conversation)
    .bind(FLOWING_MINUTES)
    .fetch_one(&st.pool)
    .await?;
    let (read, land, plan) = {
        let mut rng = rand::thread_rng();
        (rng.gen_range(READ_SECS.0..READ_SECS.1), rng.gen_range(COLD_SECS.0..COLD_SECS.1), bursts(text.chars().count(), &mut rng))
    };
    let mut pause = read;
    if !flowing {
        // landing `land` after their last message: what's left of it once the typing is counted
        let last_in: Option<DateTime<Utc>> = sqlx::query_scalar("SELECT last_in_at FROM db_pigeon_conversations WHERE id = $1").bind(conversation).fetch_one(&st.pool).await?;
        let typing: f64 = plan.iter().map(|(on, off)| on + off).sum();
        let elapsed = last_in.map_or(0.0, |t| (Utc::now() - t).num_milliseconds() as f64 / 1000.0);
        pause = pause.max(land - typing - elapsed);
    }
    // the chat shows it typing, and when the reply lands
    let lands = Utc::now() + chrono::Duration::milliseconds(((pause + plan.iter().map(|(on, off)| on + off).sum::<f64>()) * 1000.0) as i64);
    crate::apps::pigeon::events::working(&st.pool, conversation, "typing", Some(lands), None).await;
    if let Some(why) = wait(st, conversation, since, pause).await? {
        return Ok(Some(why));
    }
    for (on, off) in plan {
        if let Err(e) = c.typing(st, conversation, true).await {
            log::debug!("typing on {conversation}: {e:#}");
        }
        let mut why = wait(st, conversation, since, on).await?;
        if why.is_none() && off > 0.0 {
            let _ = c.typing(st, conversation, false).await;
            why = wait(st, conversation, since, off).await?;
        }
        if let Some(why) = why {
            let _ = c.typing(st, conversation, false).await;
            return Ok(Some(why));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use super::*;
    use rand::SeedableRng;

    #[test]
    fn bursts_add_up() {
        for seed in 0..200 {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            for chars in [0, 10, 60, 200, 2000] {
                let b = bursts(chars, &mut rng);
                let typing: f64 = b.iter().map(|(on, _)| on).sum();
                assert!((TYPING_SECS.0 - 1e-9..=TYPING_SECS.1 + 1e-9).contains(&typing), "{chars} chars: {typing}");
                assert_eq!(b.last().unwrap().1, 0.0);
                assert!(b[..b.len() - 1].iter().all(|(on, off)| *on >= BURST_SECS.0 && *off >= BREAK_SECS.0));
            }
        }
    }
}

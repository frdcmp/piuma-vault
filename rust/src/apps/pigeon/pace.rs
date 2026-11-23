//! How an auto reply goes out like a person writing it, on channels that show "typing…"
//! (WhatsApp, Instagram), by the user's timing (`timing`: its defaults in brackets). The reply is
//! written first, unseen (the user reading their message); then:
//!
//!   - a pause before "typing…" (3–8 s, reading it); in a quiet chat (nobody on the user's side
//!     wrote there in the last 15 minutes) longer, so the reply lands 35–70 s after their last
//!     message. What they sent shows read (blue ticks, "Seen") at the start of the reading pause
//!   - "typing…" in bursts, with short breaks where it goes off, for about as long as a person
//!     takes to type the reply on a phone (6 characters a second, kept within 3–45 s); it ends
//!     with the reply sent
//!
//! When they write again meanwhile, or the user writes there themselves, it stops and nothing goes
//! out: the next round answers all of it (or the user did). A reply written on the user's answer to
//! Pigeon's question is their decision: it goes out whatever they write meanwhile ("so?", nagging
//! for it), stopping only for the user.

use std::time::Duration;

use chrono::{DateTime, Utc};
use rand::Rng;
use uuid::Uuid;

use crate::apps::pigeon::connectors::Connector;
use crate::apps::pigeon::state::State;
use crate::apps::pigeon::timing::{self, Timing};

/// One burst of "typing…", and a break between two.
const BURST_SECS: (f64, f64) = (timing::BURST_MIN, 7.0);
const BREAK_SECS: (f64, f64) = (1.0, timing::BREAK_MAX);
/// How often a wait looks for a new message.
const CHECK_SECS: f64 = 1.0;

/// A time at random within `[from, to]` (the user may set both the same).
fn between(rng: &mut impl Rng, [from, to]: [f64; 2]) -> f64 {
    if from < to {
        rng.gen_range(from..to)
    } else {
        from
    }
}

/// The bursts of "typing…" for a reply this long: (typing, then off) each; the last one's off is 0
/// (the reply goes out at its end).
pub fn bursts(chars: usize, t: &Timing, rng: &mut impl Rng) -> Vec<(f64, f64)> {
    let total = (chars as f64 / t.chars_per_sec * rng.gen_range(0.75..1.25)).clamp(t.typing_secs[0], t.typing_secs[1]);
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

/// Whether they (or the user) wrote in the conversation after `since`, and who; `theirs`: whether
/// their messages stop it too.
async fn interrupted(st: &State, conversation: Uuid, since: DateTime<Utc>, theirs: bool) -> anyhow::Result<Option<&'static str>> {
    let who: Option<String> = sqlx::query_scalar(
        "SELECT author FROM db_pigeon_items WHERE conversation_id = $1 AND created_at > $2 AND (author = 'me' OR ($3 AND author = 'them'))
          ORDER BY created_at DESC LIMIT 1",
    )
    .bind(conversation)
    .bind(since)
    .bind(theirs)
    .fetch_optional(&st.pool)
    .await?;
    if let Some(w) = who {
        return Ok(Some(if w == "me" { "you wrote there" } else { "they wrote again" }));
    }
    // the user paused auto replies here meanwhile (the pill): the reply waits for them instead
    if let Some(c) = crate::apps::pigeon::conversations::get(&st.pool, conversation).await? {
        let pol = crate::apps::pigeon::policy::resolve(&st.pool, &c.user_id, crate::apps::pigeon::connectors::Kind::Reply, c.contact_id, Some(c.id)).await?;
        if !pol.alone() {
            return Ok(Some(PAUSED));
        }
    }
    Ok(None)
}

/// Why the pacing stopped when the user paused auto replies: the reply becomes theirs to send.
pub const PAUSED: &str = "you paused auto replies";

/// Waits `secs`, looking for a new message every second.
async fn wait(st: &State, conversation: Uuid, since: DateTime<Utc>, theirs: bool, secs: f64) -> anyhow::Result<Option<&'static str>> {
    let mut left = secs;
    while left > 0.0 {
        let step = left.min(CHECK_SECS);
        tokio::time::sleep(Duration::from_secs_f64(step)).await;
        left -= step;
        if let Some(why) = interrupted(st, conversation, since, theirs).await? {
            return Ok(Some(why));
        }
    }
    Ok(None)
}

/// The pause and the typing before an auto reply of `text` goes out. `since`: what came in after
/// it is new (the reply wasn't written for it); `theirs`: whether their new messages stop it (not
/// for a reply on the user's answer). Ok(None): send it now ("typing…" still on); Some: why not
/// (it's taken off).
pub async fn before_send(st: &State, c: &dyn Connector, conversation: Uuid, text: &str, since: DateTime<Utc>, theirs: bool) -> anyhow::Result<Option<&'static str>> {
    let t = timing::of_conversation(&st.pool, conversation, st.cfg.triage_debounce).await?;
    let flowing: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_items WHERE conversation_id = $1 AND author IN ('me', 'pigeon') AND at > NOW() - make_interval(secs => $2))",
    )
    .bind(conversation)
    .bind(t.quiet_minutes * 60.0)
    .fetch_one(&st.pool)
    .await?;
    let (read, land, plan) = {
        let mut rng = rand::thread_rng();
        (between(&mut rng, t.read_secs), between(&mut rng, t.cold_secs), bursts(text.chars().count(), &t, &mut rng))
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
    // it opens the chat `read` before typing: what they sent shows read from then
    let opens = (pause - read).max(0.0);
    if let Some(why) = wait(st, conversation, since, theirs, opens).await? {
        return Ok(Some(why));
    }
    if let Err(e) = c.seen(st, conversation).await {
        log::debug!("seen on {conversation}: {e:#}");
    }
    if let Some(why) = wait(st, conversation, since, theirs, pause - opens).await? {
        return Ok(Some(why));
    }
    for (on, off) in plan {
        if let Err(e) = c.typing(st, conversation, true).await {
            log::debug!("typing on {conversation}: {e:#}");
        }
        let mut why = wait(st, conversation, since, theirs, on).await?;
        if why.is_none() && off > 0.0 {
            let _ = c.typing(st, conversation, false).await;
            why = wait(st, conversation, since, theirs, off).await?;
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
        let mut t = Timing::defaults(std::time::Duration::from_secs(20));
        for seed in 0..200 {
            let mut rng = rand::rngs::StdRng::seed_from_u64(seed);
            // the user's typing, a short one too (a burst can't be shorter than its least)
            t.typing_secs = if seed % 2 == 0 { [3.0, 45.0] } else { [1.0, 2.0] };
            for chars in [0, 10, 60, 200, 2000] {
                let b = bursts(chars, &t, &mut rng);
                let typing: f64 = b.iter().map(|(on, _)| on).sum();
                assert!((t.typing_secs[0] - 1e-9..=t.typing_secs[1] + 1e-9).contains(&typing), "{chars} chars: {typing}");
                assert_eq!(b.last().unwrap().1, 0.0);
                assert!(b[..b.len() - 1].iter().all(|(on, off)| *on >= BURST_SECS.0 && *off >= BREAK_SECS.0));
            }
        }
    }
}

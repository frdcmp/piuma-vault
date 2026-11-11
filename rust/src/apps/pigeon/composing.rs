//! The reply Pigeon writes into the user's own message box (the draft button): written in a task of
//! its own (`start`), whatever the phone does meanwhile. The words wait here, by conversation, for
//! the chat to take them (`take`), and the user's apps hear it's ready (`events::kinds::COMPOSED`).
//! In memory: one backend, and a restart only loses a draft not yet taken.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use chrono::{DateTime, Duration, Utc};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::events::{self, kinds};
use crate::apps::pigeon::state::AppState;
use crate::apps::pigeon::agent;

/// What it says when the drafter wrote nothing.
pub const NOTHING: &str = "Pigeon wrote nothing this time: try again, or tell it what to say";
/// How long finished words wait to be taken.
const KEEP_MINUTES: i64 = 60;
/// One still being written past this is lost (the backend restarted under it).
const WRITING_MINUTES: i64 = 5;

#[derive(Clone, Debug, PartialEq)]
enum Slot {
    Writing(DateTime<Utc>),
    Done { text: Result<String, String>, at: DateTime<Utc> },
}

fn slots() -> &'static Mutex<HashMap<Uuid, Slot>> {
    static SLOTS: OnceLock<Mutex<HashMap<Uuid, Slot>>> = OnceLock::new();
    SLOTS.get_or_init(Default::default)
}

/// Pigeon starts writing the reply; the words wait for `take`, and the user's apps hear when
/// they're there. What it gives back settles then.
pub fn start(st: AppState, user: String, conversation: Uuid, instructions: Option<String>) -> tokio::sync::oneshot::Receiver<()> {
    slots().lock().unwrap().insert(conversation, Slot::Writing(Utc::now()));
    let (tx, rx) = tokio::sync::oneshot::channel();
    actix_web::rt::spawn(async move {
        let text = match agent::compose_reply(&st, conversation, instructions.as_deref()).await {
            Ok(Some(t)) => Ok(t),
            Ok(None) => Err(NOTHING.to_string()),
            Err(e) => Err(format!("{e:#}")),
        };
        slots().lock().unwrap().insert(conversation, Slot::Done { text, at: Utc::now() });
        events::publish(&st.pool, &user, kinds::COMPOSED, Some(conversation)).await;
        let _ = tx.send(());
    });
    rx
}

/// Pigeon writes the reply; the words, if whoever asked is still there. Gone meanwhile: they wait
/// for `take`. (The apps before `start`: the answer was the words, and one the phone never got,
/// away or its connection cut on the way, was lost.)
pub async fn compose(st: AppState, user: String, conversation: Uuid, instructions: Option<String>) -> anyhow::Result<String> {
    start(st, user, conversation, instructions).await.map_err(|_| anyhow::anyhow!("Pigeon stopped writing: try again"))?;
    match take_slot(conversation) {
        Some(Slot::Done { text, .. }) => text.map_err(|e| anyhow::anyhow!(e)),
        // another draft asked meanwhile took its place: that one answers
        _ => anyhow::bail!("Pigeon is writing another one"),
    }
}

/// Where the conversation's words are: `{writing: true}`, `{text}` or `{error}` (taken: they're
/// the chat's now), or `{}`.
pub fn take(conversation: Uuid) -> Json {
    let mut slots = slots().lock().unwrap();
    let now = Utc::now();
    slots.retain(|_, s| match s {
        Slot::Writing(at) => now - *at < Duration::minutes(WRITING_MINUTES),
        Slot::Done { at, .. } => now - *at < Duration::minutes(KEEP_MINUTES),
    });
    match slots.get(&conversation) {
        Some(Slot::Writing(_)) => json!({ "writing": true }),
        Some(Slot::Done { .. }) => match slots.remove(&conversation) {
            Some(Slot::Done { text: Ok(t), .. }) => json!({ "text": t }),
            Some(Slot::Done { text: Err(e), .. }) => json!({ "error": e }),
            _ => json!({}),
        },
        None => json!({}),
    }
}

fn take_slot(conversation: Uuid) -> Option<Slot> {
    let mut slots = slots().lock().unwrap();
    match slots.get(&conversation) {
        Some(Slot::Done { .. }) => slots.remove(&conversation),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn words_wait_once() {
        let id = Uuid::new_v4();
        assert_eq!(take(id), json!({}));
        slots().lock().unwrap().insert(id, Slot::Writing(Utc::now()));
        assert_eq!(take(id), json!({ "writing": true }));
        slots().lock().unwrap().insert(id, Slot::Done { text: Ok("ciao".into()), at: Utc::now() });
        assert_eq!(take(id), json!({ "text": "ciao" }));
        assert_eq!(take(id), json!({}), "taken: gone");
        slots().lock().unwrap().insert(id, Slot::Writing(Utc::now() - Duration::minutes(WRITING_MINUTES + 1)));
        assert_eq!(take(id), json!({}), "lost under a restart");
    }
}

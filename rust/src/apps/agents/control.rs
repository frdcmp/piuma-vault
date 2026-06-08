//! Control plane for an in-flight chat turn — the side channels the streaming
//! task can't carry on its own one-way SSE stream:
//!
//! - **STOP**: a single-shot [`CancelToken`] the turn `select!`s on, fired by
//!   `POST /agents/conversations/{id}/stop`, so a click halts generation
//!   mid-stream (the dropped `deepseek::call` future closes the provider socket).
//! - **INJECT**: a per-conversation mailbox of messages pushed mid-turn by
//!   `POST /agents/conversations/{id}/inject`, drained at each round boundary.
//!
//! Keyed by conversation id (one active turn per conversation). The handle is an
//! `Arc`-backed `Clone`, stored as actix app data like the event buses.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tokio::sync::Notify;
use uuid::Uuid;

/// Single-shot cancellation handle for one running turn. `notify_one` stores a
/// permit, so a `cancel()` that races ahead of [`CancelToken::cancelled`] is not
/// missed; the `AtomicBool` makes re-checks cheap and idempotent.
#[derive(Clone)]
pub struct CancelToken {
    flag: Arc<AtomicBool>,
    notify: Arc<Notify>,
}

impl CancelToken {
    fn new() -> Self {
        Self {
            flag: Arc::new(AtomicBool::new(false)),
            notify: Arc::new(Notify::new()),
        }
    }

    pub fn cancel(&self) {
        self.flag.store(true, Ordering::SeqCst);
        self.notify.notify_one();
    }

    pub fn is_cancelled(&self) -> bool {
        self.flag.load(Ordering::SeqCst)
    }

    /// Resolves as soon as `cancel()` has been (or is) called. Safe to `select!`
    /// on: returns immediately if already cancelled.
    pub async fn cancelled(&self) {
        if self.is_cancelled() {
            return;
        }
        self.notify.notified().await;
    }
}

/// Per-conversation cancel tokens + injection mailboxes for running turns.
#[derive(Clone, Default)]
pub struct TurnControl {
    cancels: Arc<Mutex<HashMap<Uuid, CancelToken>>>,
    inbox: Arc<Mutex<HashMap<Uuid, Vec<String>>>>,
}

impl TurnControl {
    pub fn new() -> Self {
        Self::default()
    }

    /// Register a fresh cancel token for a starting turn (replacing any stale one
    /// for this conversation). Returns the token for the turn to `select!` on.
    pub fn begin(&self, conv: Uuid) -> CancelToken {
        let token = CancelToken::new();
        self.cancels.lock().unwrap().insert(conv, token.clone());
        token
    }

    /// Cancel the running turn for a conversation, if any. Returns whether a turn
    /// was registered.
    pub fn cancel(&self, conv: Uuid) -> bool {
        match self.cancels.lock().unwrap().get(&conv) {
            Some(tok) => {
                tok.cancel();
                true
            }
            None => false,
        }
    }

    /// Tear down a finished turn: drop its cancel token and clear its mailbox so
    /// stale injections can't leak into a later turn.
    pub fn end(&self, conv: Uuid) {
        self.cancels.lock().unwrap().remove(&conv);
        self.inbox.lock().unwrap().remove(&conv);
    }

    /// Is a turn currently registered for this conversation?
    pub fn is_active(&self, conv: Uuid) -> bool {
        self.cancels.lock().unwrap().contains_key(&conv)
    }

    /// Queue a message to be injected into a conversation's running turn.
    pub fn inject(&self, conv: Uuid, text: String) {
        self.inbox
            .lock()
            .unwrap()
            .entry(conv)
            .or_default()
            .push(text);
    }

    /// Take all pending injected messages for a conversation (empties the mailbox).
    pub fn drain(&self, conv: Uuid) -> Vec<String> {
        match self.inbox.lock().unwrap().get_mut(&conv) {
            Some(v) if !v.is_empty() => std::mem::take(v),
            _ => Vec::new(),
        }
    }
}

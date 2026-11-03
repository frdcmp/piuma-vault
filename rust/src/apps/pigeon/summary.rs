//! The morning's "what's open", in General at 9 (the user's time): replies waiting for their
//! Send, what Pigeon asks them, who's still unanswered, tasks and events to confirm. People whose
//! alerts are off are in it too: it's the "later" they were kept for. "Nothing open" when nothing
//! is.

use chrono::{DateTime, Utc};
use serde_json::json;
use uuid::Uuid;

use crate::apps::pigeon::state::State;
use crate::apps::pigeon::{cards, conversations, owner, slugs};

/// The summary's hour, the user's time.
const HOUR: u32 = 9;
/// A slot missed by longer than this (the worker down) is skipped.
const LATE_HOURS: i64 = 3;

/// Whether the user's daily slot (`hour`, their time) is due now: passed today, not long ago, not
/// run since. Marked as run when it is (`db_pigeon_settings`, `key`).
pub async fn due(st: &State, user: &str, key: &str, hour: u32) -> anyhow::Result<bool> {
    let tz = owner::get(&st.pool, user).await.tz;
    let now = Utc::now();
    let local = now.with_timezone(&tz);
    let Some(slot) = local.date_naive().and_hms_opt(hour, 0, 0).and_then(|t| t.and_local_timezone(tz).single()) else { return Ok(false) };
    let slot = slot.with_timezone(&Utc);
    if now < slot || now - slot > chrono::Duration::hours(LATE_HOURS) {
        return Ok(false);
    }
    let last: Option<serde_json::Value> =
        sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(key).fetch_optional(&st.pool).await?;
    let last = last.and_then(|v| v.as_str().and_then(|t| DateTime::parse_from_rfc3339(t).ok())).map(|t| t.with_timezone(&Utc));
    if last.is_some_and(|l| l >= slot) {
        return Ok(false);
    }
    sqlx::query(
        "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    )
    .bind(user)
    .bind(key)
    .bind(json!(now.to_rfc3339()))
    .execute(&st.pool)
    .await?;
    Ok(true)
}

/// "@marco" (or their name) for a conversation.
async fn who(st: &State, conversation: Uuid) -> anyhow::Result<String> {
    let Some(conv) = conversations::get(&st.pool, conversation).await? else { return Ok("?".into()) };
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let name = conversations::who(contact.as_ref(), &conv);
    Ok(slugs::tag(st, conv.contact_id, &name).await)
}

/// "5h", "2d".
fn age(t: DateTime<Utc>) -> String {
    let h = (Utc::now() - t).num_hours();
    if h < 24 {
        format!("{}h", h.max(1))
    } else {
        format!("{}d", h / 24)
    }
}

/// Names once each, in order.
fn join(mut names: Vec<String>) -> String {
    let mut seen = Vec::new();
    names.retain(|n| {
        let new = !seen.contains(n);
        seen.push(n.clone());
        new
    });
    names.join(", ")
}

/// The summary's text.
pub async fn render(st: &State, user: &str) -> anyhow::Result<String> {
    let drafts: Vec<Uuid> = sqlx::query_scalar(
        "SELECT conversation_id FROM db_pigeon_actions WHERE user_id = $1 AND status = 'pending' AND kind = 'reply' AND conversation_id IS NOT NULL ORDER BY created_at",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let asks: Vec<Uuid> = sqlx::query_scalar(
        "SELECT q.conversation_id FROM db_pigeon_questions q JOIN db_pigeon_conversations c ON c.id = q.conversation_id
          WHERE c.user_id = $1 AND q.status = 'open' ORDER BY q.created_at",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let todo: Vec<(String,)> = sqlx::query_as(
        "SELECT COALESCE(args->>'title', action) FROM db_pigeon_actions WHERE user_id = $1 AND status = 'pending' AND kind <> 'reply' ORDER BY created_at LIMIT 8",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let unanswered: Vec<(Uuid, DateTime<Utc>)> = sqlx::query_as(
        "SELECT id, last_in_at FROM db_pigeon_conversations
          WHERE user_id = $1 AND attention = 'reply' AND last_in_at > NOW() - INTERVAL '7 days'
            AND (handled_at IS NULL OR handled_at < last_in_at) AND (last_out_at IS NULL OR last_out_at < last_in_at)
            AND NOT EXISTS (SELECT 1 FROM db_pigeon_actions a WHERE a.conversation_id = db_pigeon_conversations.id AND a.status = 'pending' AND a.kind = 'reply')
            AND NOT EXISTS (SELECT 1 FROM db_pigeon_questions q WHERE q.conversation_id = db_pigeon_conversations.id AND q.status = 'open')
          ORDER BY importance DESC NULLS LAST, last_in_at DESC LIMIT 8",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    let mut lines = Vec::new();
    if !drafts.is_empty() {
        let mut n = Vec::new();
        for c in &drafts {
            n.push(who(st, *c).await?);
        }
        lines.push(format!("✍ replies to send: {}", join(n)));
    }
    if !asks.is_empty() {
        let mut n = Vec::new();
        for c in &asks {
            n.push(who(st, *c).await?);
        }
        lines.push(format!("❓ Pigeon asks you about: {}", join(n)));
    }
    if !unanswered.is_empty() {
        // a person once (several chats with them: the one that matters most)
        let mut n = Vec::new();
        let mut seen = Vec::new();
        for (c, at) in &unanswered {
            let w = who(st, *c).await?;
            if !seen.contains(&w) {
                n.push(format!("{w} ({})", age(*at)));
                seen.push(w);
            }
        }
        lines.push(format!("⏳ unanswered: {}", join(n)));
    }
    if !todo.is_empty() {
        lines.push(format!("📌 to confirm: {}", join(todo.into_iter().map(|(t,)| conversations::clip(&t, 40)).collect())));
    }
    Ok(if lines.is_empty() { "☀️ Nothing open this morning".into() } else { format!("☀️ Open this morning\n{}", lines.join("\n")) })
}

/// The user's morning summary, when it's due.
pub async fn tick(st: &State, user: &str) -> anyhow::Result<()> {
    if due(st, user, "summary:morning", HOUR).await? {
        let text = render(st, user).await?;
        cards::alert(st, user, &text).await;
    }
    Ok(())
}

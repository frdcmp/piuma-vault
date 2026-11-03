//! "Ask Piuma" from an Inbox chat: the conversation goes with the user's message as context (as
//! attached notes do), so Piuma knows what they're talking about and can act on it with its
//! Pigeon tools.

use uuid::Uuid;

use crate::apps::pigeon::{conversations, owner, state};
use crate::db::db::DbPool;

/// The latest messages shown.
const ITEMS: i64 = 30;

/// The attached conversations, as a context block (empty when none is the user's).
pub async fn for_chat(pool: &DbPool, user: &str, ids: &[Uuid]) -> String {
    if ids.is_empty() {
        return String::new();
    }
    let st = state::shared(pool);
    let me = owner::get(pool, user).await;
    let handles = conversations::my_handles(pool, user).await.unwrap_or_default();
    let mut s = String::new();
    for id in ids {
        let Ok(Some(conv)) = conversations::get(pool, *id).await else { continue };
        if conv.user_id != user {
            continue;
        }
        let contact = conversations::contact(pool, conv.contact_id).await.ok().flatten();
        let them = conversations::who(contact.as_ref(), &conv);
        let items = conversations::recent_items(pool, conv.id, ITEMS).await.unwrap_or_default();
        let channel = crate::apps::pigeon::connectors::find(&st, &conv.connector).map(|c| c.title()).unwrap_or("?");
        s.push_str(&format!(
            "## Inbox conversation with {them} on {channel} (conversation_id {})\n{}\n",
            conv.id,
            conversations::transcript(&items, &them, (&me.name, &handles), 1500)
        ));
    }
    if s.is_empty() {
        return s;
    }
    format!("The user attached these Inbox conversations as context (act on them with the pigeon_* tools; a message to someone is a draft):\n\n{s}")
}

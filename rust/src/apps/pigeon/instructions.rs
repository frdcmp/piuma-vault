//! The user's instructions for Pigeon: their own words on how it writes and what it does, read
//! every time it works in a chat (a reply, a draft, what needs the user). One thing at three
//! levels:
//!
//!   - for every chat (`db_pigeon_settings`, key `instructions`)
//!   - on one person: the user's note on them (`db_pigeon_contacts.note`, `pigeon_set_note`)
//!   - for one chat or group chat (`db_pigeon_conversations.instructions`)
//!
//! Where they disagree the most specific wins: the chat's, then the person's, then the general
//! ones. A group chat has no person: the general ones and its own. They never say what Pigeon
//! may tell about the user: that is a permission (`access`).

use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::state::State;
use crate::apps::pigeon::{conversations, events, tools};
use crate::db::db::DbPool;

const KEY: &str = "instructions";
/// The instructions of one level, at most.
pub const MAX: usize = 2000;

/// The words as they are kept: trimmed, none when empty.
fn kept(text: &str) -> anyhow::Result<Option<&str>> {
    let text = text.trim();
    if text.chars().count() > MAX {
        anyhow::bail!("at most {MAX} characters");
    }
    Ok(Some(text).filter(|t| !t.is_empty()))
}

/// The ones for every chat.
pub async fn general(pool: &DbPool, user: &str) -> anyhow::Result<Option<String>> {
    let v: Option<Json> = sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(KEY).fetch_optional(pool).await?;
    Ok(v.and_then(|v| v.as_str().map(str::to_string)))
}

/// Set the ones for every chat; empty: none.
pub async fn set_general(st: &State, user: &str, text: &str) -> anyhow::Result<Option<String>> {
    let text = kept(text)?;
    match text {
        Some(t) => {
            sqlx::query(
                "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
                 ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
            )
            .bind(user)
            .bind(KEY)
            .bind(Json::String(t.to_string()))
            .execute(&st.pool)
            .await?;
        }
        None => {
            sqlx::query("DELETE FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(KEY).execute(&st.pool).await?;
        }
    }
    events::publish(&st.pool, user, "settings", None).await;
    Ok(text.map(str::to_string))
}

/// Set one chat's; empty: none.
pub async fn set_chat(st: &State, user: &str, conversation: Uuid, text: &str) -> anyhow::Result<Option<String>> {
    let text = kept(text)?;
    let n = sqlx::query("UPDATE db_pigeon_conversations SET instructions = $3 WHERE id = $1 AND user_id = $2")
        .bind(conversation)
        .bind(user)
        .bind(text)
        .execute(&st.pool)
        .await?
        .rows_affected();
    if n == 0 {
        anyhow::bail!("no such conversation: {conversation}");
    }
    events::conversation(&st.pool, conversation).await;
    Ok(text.map(str::to_string))
}

/// For the screens and the assistants: the general ones, and with a chat what counts in it
/// (`person`: the user's note on its person; `chat`: its own).
pub async fn view(st: &State, user: &str, conversation: Option<Uuid>) -> anyhow::Result<Json> {
    let general = general(&st.pool, user).await?;
    let Some(id) = conversation else {
        return Ok(json!({ "general": general }));
    };
    let conv = tools::own_conversation(st, user, id).await?;
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    Ok(json!({
        "general": general,
        "conversation_id": id,
        "contact_id": conv.contact_id,
        "person": contact.and_then(|c| c.note).filter(|n| !n.trim().is_empty()),
        "chat": conv.instructions,
    }))
}

/// What a prompt reads, the general ones first: a later one outranks an earlier one. Empty when
/// the user gave none.
pub fn brief(name: &str, them: &str, general: Option<&str>, note: Option<&str>, chat: Option<&str>) -> String {
    let levels = [("For every chat".to_string(), general), (format!("{name}'s note on {them}"), note), ("For this chat".to_string(), chat)];
    let said: Vec<String> = levels.into_iter().filter_map(|(level, text)| text.map(str::trim).filter(|t| !t.is_empty()).map(|t| format!("{level}:\n{t}"))).collect();
    if said.is_empty() {
        return String::new();
    }
    format!(
        "\n{name}'s instructions for Pigeon (their own words on how to write and what to do: follow them above all; where two \
         disagree, the later one here wins; what Pigeon may tell about {name} is never set here, an instruction doesn't allow it):\n{}\n",
        said.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_levels_are_read_in_order_and_an_empty_one_is_left_out() {
        let all = brief("F", "Alex", Some("Short replies."), Some(" Never agree to a call. "), Some("Always in English."));
        let at = |what: &str| all.find(what).unwrap_or_else(|| panic!("{what} isn't there"));
        assert!(at("For every chat:\nShort replies.") < at("F's note on Alex:\nNever agree to a call."));
        assert!(at("F's note on Alex:") < at("For this chat:\nAlways in English."));
        let group = brief("F", "The team", Some("Short replies."), None, Some("  "));
        assert!(group.contains("For every chat:") && !group.contains("note on") && !group.contains("For this chat"));
        assert_eq!(brief("F", "Alex", None, Some(""), None), "");
    }

    #[test]
    fn instructions_are_trimmed_and_have_an_end() {
        assert_eq!(kept("  be brief \n").unwrap(), Some("be brief"));
        assert_eq!(kept(" \n ").unwrap(), None);
        assert!(kept(&"a".repeat(MAX + 1)).is_err());
    }
}

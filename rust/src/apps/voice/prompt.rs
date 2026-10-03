//! What the voice model is told and allowed to do. The tool set is a short,
//! voice-shaped subset of the vault agent's catalogue: realtime models re-read
//! every declaration each turn (and get less accurate with long lists), and
//! nothing destructive is offered by voice.

use serde_json::Value;
use uuid::Uuid;

use crate::apps::agents::chat::blocks_to_text;
use crate::db::db::DbPool;

/// Candidate voice tools. Narrowed further by the agent's subscription and the
/// persona's `allowed_tools` (see `handlers::enabled_tools`).
pub const VOICE_TOOLS: &[&str] = &[
    "get_agenda",
    "list_tasks",
    "get_task",
    "create_task",
    "update_task",
    "toggle_task",
    "list_events",
    "get_event",
    "create_event",
    "update_event",
    "search_notes",
    "read_note",
    "browse_folder",
    "search_folders",
    "create_note",
    "append_to_note",
    "memory_search",
    "memory_save",
    "web_search",
    "navigate",
];

/// How many recent messages of a continued conversation are replayed into the
/// system instruction, so the voice model knows what was said before.
const HISTORY_MESSAGES: i64 = 20;

/// Wake-phrase mode: Piuma stays silent until addressed by name, so a voice
/// session can stay open in a room without answering the TV or other people.
/// It is an instruction to the model (gemini-3.8-live's proactive audio lets it
/// choose not to respond), not a hard gate: everything the mic picks up is
/// still sent. Set to false to answer every utterance again.
pub const REQUIRE_WAKE_PHRASE: bool = true;
/// The phrase that addresses Piuma in wake-phrase mode (shown in the clients).
pub const WAKE_PHRASE: &str = "OK Piuma";

/// The wake phrase in effect for new sessions, if any.
pub fn wake_phrase() -> Option<&'static str> {
    REQUIRE_WAKE_PHRASE.then_some(WAKE_PHRASE)
}

/// The wake-phrase rule, when enabled. Placed last so it wins over the rest.
pub fn wake_block() -> Option<String> {
    let phrase = wake_phrase()?;
    Some(format!(
        "# STRICT RULE — only answer when called by name\n\n\
         The mic is always open; most of what you hear is not for you. Respond ONLY to \
         utterances containing your name (\"{phrase}\", \"Piuma\"; transcripts may write \
         \"Puma\"), follow-ups included. Anything else — even assistant-like questions — \
         gets no reply, no filler, no tool calls. If unsure, stay silent. Never repeat the \
         wake phrase."
    ))
}

/// Spoken-style rules. Placed after the persona prompt so it wins over any
/// chat formatting/linking guidance there.
pub fn voice_block() -> String {
    String::from(
        "# Voice mode\n\n\
         You are speaking aloud in real time: answer in 1–3 short spoken sentences, with no \
         markdown, lists, links or ids (ignore the formatting rules above). Say dates and \
         numbers naturally. Reply in the user's language. Say a few words before a slow \
         tool. Use `navigate` to show something on screen. Nothing can be deleted by voice.",
    )
}

/// The tail of a continued conversation, as plain "User:/Assistant:" lines.
pub async fn history_block(pool: &DbPool, conv_id: Uuid) -> String {
    let rows: Vec<(String, Value)> = sqlx::query_as(
        "SELECT role, content FROM ( \
           SELECT role, content, created_at FROM db_chat_messages \
           WHERE conversation_id = $1 AND role IN ('user', 'assistant') \
           ORDER BY created_at DESC LIMIT $2 \
         ) t ORDER BY created_at",
    )
    .bind(conv_id)
    .bind(HISTORY_MESSAGES)
    .fetch_all(pool)
    .await
    .unwrap_or_default();
    let lines: Vec<String> = rows
        .into_iter()
        .map(|(role, content)| (role, blocks_to_text(&content)))
        .filter(|(_, text)| !text.trim().is_empty())
        .map(|(role, text)| {
            let who = if role == "user" { "User" } else { "Assistant" };
            format!("{who}: {}", text.trim())
        })
        .collect();
    if lines.is_empty() {
        return String::new();
    }
    format!(
        "# Conversation so far\n\nThis conversation continues; here is what was said most \
         recently:\n\n{}",
        lines.join("\n")
    )
}

//! console (dev, PIGEON_CONSOLE=1): a pretend channel to try the whole flow without any account.
//! In: `POST /pigeon/console/receive` takes a message "from" someone into a thread of the signed-in
//! user. Out: its reply is recorded as sent in that thread, and goes nowhere.

use async_trait::async_trait;
use chrono::Utc;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::connectors::{need_str, ActionDef, Connector, Kind};
use crate::apps::pigeon::items::{self, Author, Direction, Incoming};
use crate::apps::pigeon::state::State;

pub struct Console;

pub const ID: &str = "console";

#[async_trait]
impl Connector for Console {
    fn id(&self) -> &'static str {
        ID
    }

    fn title(&self) -> &'static str {
        "Console (dev)"
    }

    fn available(&self, st: &State) -> Result<(), String> {
        if st.cfg.console {
            Ok(())
        } else {
            Err("dev only: PIGEON_CONSOLE=1".into())
        }
    }

    fn actions(&self) -> Vec<ActionDef> {
        vec![ActionDef {
            name: "send_reply",
            kind: Kind::Reply,
            description: "Reply in a console conversation (dev: recorded as sent, goes nowhere).",
            params: json!({
                "type": "object",
                "properties": { "text": { "type": "string", "description": "The reply, as the user" } },
                "required": ["text"],
            }),
            on_conversation: true,
            agent: true,
        }]
    }

    fn shows_typing(&self) -> bool {
        true
    }

    /// Logged, so a paced auto reply can be watched (and checked: scripts/scenarios.sh).
    async fn typing(&self, _st: &State, conversation: Uuid, on: bool) -> anyhow::Result<()> {
        log::info!("console: typing {} in {conversation}", if on { "on" } else { "off" });
        Ok(())
    }

    async fn run(&self, st: &State, user: &str, action: &str, args: &Json, conversation: Option<Uuid>) -> anyhow::Result<Json> {
        match action {
            "send_reply" => {
                let text = need_str(args, "text")?;
                let conv = conversation.ok_or_else(|| anyhow::anyhow!("needs a conversation"))?;
                let thread: String = sqlx::query_scalar("SELECT external_id FROM db_pigeon_conversations WHERE id = $1 AND connector = $2 AND user_id = $3")
                    .bind(conv)
                    .bind(ID)
                    .bind(user)
                    .fetch_one(&st.pool)
                    .await?;
                let id = format!("console-out-{}", Uuid::new_v4());
                let inc = Incoming {
                    user_id: user.to_string(),
                    connector: ID,
                    connection_id: None,
                    thread,
                    thread_title: None,
                    external_id: id.clone(),
                    direction: Direction::Out,
                    author: Author::Pigeon,
                    sender: Some("me".into()),
                    sender_name: None,
                    subject: None,
                    body: text.to_string(),
                    media: json!([]),
                    raw: json!({}),
                    at: Utc::now(),
                    counterpart: None,
                    window: None,
                    triage: false,
                };
                items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?;
                Ok(json!({ "sent": true, "id": id }))
            }
            other => anyhow::bail!("console has no action '{other}'"),
        }
    }

    async fn health(&self, st: &State, _user: &str) -> Json {
        json!({ "available": self.available(st).is_ok() })
    }
}

/// A message "from" someone, into one of the user's console threads (default: one thread per
/// sender). `me`: as if the user wrote it themselves from their phone.
pub async fn receive(st: &State, user: &str, from: &str, name: Option<&str>, text: &str, thread: Option<&str>, me: bool) -> anyhow::Result<Uuid> {
    let from = from.trim().to_lowercase();
    let inc = Incoming {
        user_id: user.to_string(),
        connector: ID,
        connection_id: None,
        thread: thread.map(str::to_string).unwrap_or_else(|| format!("console:{from}")),
        thread_title: name.map(str::to_string).or_else(|| Some(from.clone())),
        external_id: format!("console-{}", Uuid::new_v4()),
        direction: if me { Direction::Out } else { Direction::In },
        author: if me { Author::Me } else { Author::Them },
        sender: Some(if me { "me".into() } else { from.clone() }),
        sender_name: if me { None } else { name.map(str::to_string) },
        subject: None,
        body: text.to_string(),
        media: json!([]),
        raw: json!({}),
        at: Utc::now(),
        counterpart: Some((from, name.map(str::to_string))),
        window: None,
        triage: true,
    };
    let got = items::ingest(&st.pool, &inc, st.cfg.triage_debounce).await?.ok_or_else(|| anyhow::anyhow!("stored already"))?;
    Ok(got.conversation_id)
}

//! Confirmations: what Piuma may only do on the user's tap. A big change asked in the chat (auto
//! switched on, a reply policy to auto, a merge, a rule deleted, set to auto or to trash, a rule
//! run on past messages) isn't done: it's kept (`db_pigeon_confirmations`) and shown as a 🕊 card in
//! the Inbox (the conversation's, or General), and runs when the user taps Yes. Piuma is told it
//! waits, and why; it can't press the card itself.

use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::connectors::Kind;
use crate::apps::pigeon::policy::Policy;
use crate::apps::pigeon::state::{AppState, State};
use crate::apps::pigeon::{events, people, rules, tools};

/// What a tool would change, when that needs the user's tap: the card's words, and where it
/// shows (a conversation, or General).
pub struct Tap {
    pub summary: String,
    pub conversation: Option<Uuid>,
}

fn name_of(c: &crate::apps::pigeon::conversations::Contact) -> String {
    c.name.clone().unwrap_or_else(|| "this contact".into())
}

/// Whether this call needs the user's tap first.
pub async fn needs_tap(st: &State, user: &str, tool: &str, args: &Json) -> anyhow::Result<Option<Tap>> {
    let general = |summary: String| Some(Tap { summary, conversation: None });
    Ok(match tool {
        "pigeon_set_auto" if args.get("enabled").and_then(Json::as_bool) == Some(true) => {
            general("Switch auto on: Pigeon acts on its own wherever a policy is auto".into())
        }
        "pigeon_set_policy" => {
            let (kind, pol, scope, scope_id) = tools::policy_args(st, user, args).await?;
            if pol != Some(Policy::Auto) {
                return Ok(None);
            }
            let what = match kind {
                Kind::Reply => "answer on its own",
                Kind::Record => "add tasks and events on its own",
                Kind::Organize => "tidy the mail on its own",
            };
            match scope {
                "conversation" => {
                    let id = Uuid::parse_str(&scope_id)?;
                    Some(Tap { summary: format!("Let Pigeon {what} in this conversation"), conversation: Some(id) })
                }
                "contact" => {
                    let c = people::mine(st, user, Uuid::parse_str(&scope_id)?).await?;
                    general(format!("Let Pigeon {what} to {}", name_of(&c)))
                }
                _ => general(format!("Let Pigeon {what} to everyone")),
            }
        }
        "pigeon_merge_contacts" => {
            let keep = people::mine(st, user, tools::opt_uuid(args, "contact_id")?.ok_or_else(|| anyhow::anyhow!("`contact_id` is required"))?).await?;
            let other = people::mine(st, user, tools::opt_uuid(args, "merge_id")?.ok_or_else(|| anyhow::anyhow!("`merge_id` is required"))?).await?;
            general(format!("Merge {} into {} (can't be undone)", name_of(&other), name_of(&keep)))
        }
        "pigeon_delete_rule" => {
            let id = args.get("rule_id").and_then(Json::as_i64).ok_or_else(|| anyhow::anyhow!("`rule_id` is required"))? as i32;
            general(format!("Delete the rule «{}»", rules::mine(st, user, id).await?.name))
        }
        "pigeon_try_rule" if args.get("apply").and_then(Json::as_bool) == Some(true) => {
            let id = args.get("rule_id").and_then(Json::as_i64).ok_or_else(|| anyhow::anyhow!("`rule_id` is required"))? as i32;
            general(format!("Run the rule «{}» on messages already in", rules::mine(st, user, id).await?.name))
        }
        "pigeon_set_rule" => {
            let id = args.get("rule_id").and_then(Json::as_i64).map(|i| i as i32);
            let r = tools::rule_input(st, user, id, args).await?;
            let before = match id {
                Some(i) => Some(rules::mine(st, user, i).await?),
                None => None,
            };
            let to_auto = r.mode == "auto" && before.as_ref().is_none_or(|b| b.mode != "auto");
            let to_trash = r.then_action == "trash" && before.as_ref().is_none_or(|b| b.then_action != "trash");
            match (to_auto, to_trash) {
                (false, false) => None,
                (a, t) => {
                    let mut what = Vec::new();
                    if a {
                        what.push("run on its own");
                    }
                    if t {
                        what.push("move what it matches to the trash");
                    }
                    general(format!("The rule «{}»: {}", r.name.trim(), what.join(", and ")))
                }
            }
        }
        _ => None,
    })
}

/// Keep the call for the user's tap; what Piuma is told.
pub async fn ask(st: &State, user: &str, tool: &str, args: &Json, tap: &Tap) -> anyhow::Result<Json> {
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_pigeon_confirmations (user_id, conversation_id, tool, args, summary) VALUES ($1, $2, $3, $4, $5) RETURNING id",
    )
    .bind(user)
    .bind(tap.conversation)
    .bind(tool)
    .bind(args)
    .bind(&tap.summary)
    .fetch_one(&st.pool)
    .await?;
    match tap.conversation {
        Some(c) => events::conversation(&st.pool, c).await,
        None => events::publish(&st.pool, user, "news", None).await,
    }
    Ok(json!({
        "needs_confirmation": true,
        "confirmation_id": id,
        "summary": tap.summary,
        "note": "Not done yet: a card in the Inbox asks the user to confirm it; it runs when they tap Yes. Tell them.",
    }))
}

/// The user tapped the card: done (or failed), or cancelled. What came of it, in a few words.
pub async fn decide(st: &AppState, user: &str, id: Uuid, yes: bool) -> anyhow::Result<String> {
    let row: Option<(String, Json, Option<Uuid>)> = sqlx::query_as(
        "UPDATE db_pigeon_confirmations SET status = CASE WHEN $3 THEN status ELSE 'cancelled' END, decided_at = NOW()
          WHERE id = $1 AND user_id = $2 AND status = 'pending' RETURNING tool, args, conversation_id",
    )
    .bind(id)
    .bind(user)
    .bind(yes)
    .fetch_optional(&st.pool)
    .await?;
    let Some((tool, args, conversation)) = row else { anyhow::bail!("that card is gone") };
    let said = if !yes {
        "✖ Cancelled".to_string()
    } else {
        let (status, result, said) = match tools::run(st, user, &tool, &args).await {
            Ok(v) => ("done", v, "✅ Done".to_string()),
            Err(e) => ("failed", json!({ "error": format!("{e:#}") }), format!("⚠ {e:#}")),
        };
        sqlx::query("UPDATE db_pigeon_confirmations SET status = $2, result = $3 WHERE id = $1").bind(id).bind(status).bind(result).execute(&st.pool).await?;
        said
    };
    match conversation {
        Some(c) => events::conversation(&st.pool, c).await,
        None => events::publish(&st.pool, user, "news", None).await,
    }
    Ok(said)
}

/// The confirmations waiting, for Piuma.
pub async fn open(st: &State, user: &str) -> anyhow::Result<Vec<Json>> {
    let rows: Vec<(Uuid, Option<Uuid>, String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, conversation_id, tool, summary, created_at FROM db_pigeon_confirmations WHERE user_id = $1 AND status = 'pending' ORDER BY created_at DESC",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, conversation_id, tool, summary, created_at)| {
            json!({ "kind": "confirmation", "id": id, "conversation_id": conversation_id, "tool": tool, "summary": summary, "created_at": created_at,
                    "note": "only the user's tap in the Inbox decides it" })
        })
        .collect())
}

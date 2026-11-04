//! Actions: proposed by the agent (or a rule, or Piuma), decided by the policy, done by a
//! connector, and every one of them kept as the log. A proposal under `ask` waits as pending (a
//! card in the Inbox) until the user approves, edits or drops it, or it expires; under `auto` it
//! runs at once, unless a safeguard holds it back to ask. The user doing an action themselves is
//! `direct`.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value as Json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::pigeon::connectors::{self, Kind};
use crate::apps::pigeon::{conversations, pace, policy};
use crate::apps::pigeon::policy::Policy;
use crate::apps::pigeon::state::State;

/// Auto replies a conversation may get in an hour; past it, they wait for the user.
const AUTO_REPLIES_PER_HOUR: i64 = 3;
/// After the user writes in a conversation themselves, no auto reply there for this long.
const QUIET_AFTER_ME_MINUTES: i64 = 10;
const REPLY_EXPIRES_DAYS: i64 = 3;
const OTHER_EXPIRES_DAYS: i64 = 7;

#[derive(Debug, Clone, Copy)]
pub enum Source {
    Agent,
    /// the user, in the Inbox
    User,
    /// the user's rules (rules)
    Rule,
    /// Piuma, the vault agent, on the user's word: its messages to people are drafts
    Piuma,
}

impl Source {
    fn as_str(self) -> &'static str {
        match self {
            Source::Agent => "agent",
            Source::User => "user",
            Source::Rule => "rule",
            Source::Piuma => "piuma",
        }
    }
}

pub struct Proposal {
    pub user_id: String,
    pub conversation_id: Option<Uuid>,
    pub connector: String,
    pub action: String,
    pub args: Json,
    pub reason: Option<String>,
    pub source: Source,
    pub triage_id: Option<i64>,
    /// Why this may not run on its own even under auto (sensitive, the mood changed, asked for
    /// as a draft): it waits for the user.
    pub hold: Option<String>,
}

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct ActionRow {
    pub id: Uuid,
    pub user_id: String,
    pub conversation_id: Option<Uuid>,
    pub connector: String,
    pub action: String,
    pub kind: String,
    pub args: Json,
    pub status: String,
    pub source: String,
    pub policy: String,
    pub reason: Option<String>,
    pub decided_by: Option<String>,
    pub decided_at: Option<DateTime<Utc>>,
    pub result: Option<Json>,
    pub error: Option<String>,
    pub expires_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

const ACTION_COLS: &str = "id, user_id, conversation_id, connector, action, kind, args, status, source, policy, reason, decided_by, decided_at, \
     result, error, expires_at, created_at";

pub async fn get(st: &State, id: Uuid) -> anyhow::Result<Option<ActionRow>> {
    Ok(sqlx::query_as(&format!("SELECT {ACTION_COLS} FROM db_pigeon_actions WHERE id = $1")).bind(id).fetch_optional(&st.pool).await?)
}

pub async fn list(st: &State, user: &str, status: Option<&str>, conversation: Option<Uuid>, limit: i64) -> anyhow::Result<Vec<ActionRow>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {ACTION_COLS} FROM db_pigeon_actions
          WHERE user_id = $4 AND ($1::text IS NULL OR status = $1) AND ($2::uuid IS NULL OR conversation_id = $2)
          ORDER BY created_at DESC LIMIT $3"
    ))
    .bind(status)
    .bind(conversation)
    .bind(limit.clamp(1, 200))
    .bind(user)
    .fetch_all(&st.pool)
    .await?)
}

/// What became of a proposal.
#[derive(Debug, Serialize)]
pub struct Outcome {
    pub id: Option<Uuid>,
    pub status: String,
    pub detail: Option<String>,
}

/// Put one proposal through its policy: dropped (off), queued (ask), or done (auto).
pub async fn propose(st: &State, p: Proposal) -> anyhow::Result<Outcome> {
    let Some(connector) = connectors::find(st, &p.connector).filter(|c| c.available(st).is_ok()) else {
        anyhow::bail!("no connector '{}' here", p.connector);
    };
    let Some(def) = connector.actions().into_iter().find(|a| a.name == p.action) else {
        anyhow::bail!("{} has no action '{}'", p.connector, p.action);
    };
    let conv = match p.conversation_id {
        Some(id) => conversations::get(&st.pool, id).await?,
        None => None,
    };
    if def.on_conversation && conv.is_none() {
        anyhow::bail!("{}.{} needs a conversation", p.connector, p.action);
    }
    let pol = policy::resolve(&st.pool, &p.user_id, def.kind, conv.as_ref().and_then(|c| c.contact_id), p.conversation_id).await?;
    // off drops what Pigeon proposes on its own; a draft the user asked for still comes to them
    if pol == Policy::Off && p.hold.as_deref() != Some(super::agent::ASKED_AS_DRAFT) {
        return Ok(Outcome { id: None, status: "off".into(), detail: Some(format!("{} actions are off here", def.kind.as_str())) });
    }

    let mut hold = p.hold.clone();
    if pol == Policy::Auto && hold.is_none() {
        if !policy::auto_enabled(&st.pool, &p.user_id).await? {
            hold = Some("auto is switched off".into());
        } else if def.kind == Kind::Reply {
            if let Some(c) = &conv {
                hold = reply_guard(st, c).await?;
            }
        }
    }

    let expires_at = match (def.kind, &conv) {
        (Kind::Reply, Some(c)) => {
            let days = Utc::now() + chrono::Duration::days(REPLY_EXPIRES_DAYS);
            Some(c.window_until.map(|w| w.min(days)).unwrap_or(days))
        }
        _ => Some(Utc::now() + chrono::Duration::days(OTHER_EXPIRES_DAYS)),
    };
    let label = if pol == Policy::Auto && hold.is_none() { "auto" } else { "ask" };
    let reason = match (&p.reason, &hold, pol) {
        (r, Some(h), Policy::Auto) => Some(format!("{} (held for approval: {h})", r.clone().unwrap_or_default()).trim().to_string()),
        (r, _, _) => r.clone(),
    };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_pigeon_actions (user_id, conversation_id, connector, action, kind, args, status, source, policy, reason, triage_id, expires_at)
         VALUES ($11, $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, $10) RETURNING id",
    )
    .bind(p.conversation_id)
    .bind(&p.connector)
    .bind(&p.action)
    .bind(def.kind.as_str())
    .bind(&p.args)
    .bind(p.source.as_str())
    .bind(label)
    .bind(&reason)
    .bind(p.triage_id)
    .bind(expires_at)
    .bind(&p.user_id)
    .fetch_one(&st.pool)
    .await?;
    if let Some(c) = p.conversation_id {
        crate::apps::pigeon::events::conversation(&st.pool, c).await;
    }

    if label == "auto" {
        if let (Kind::Reply, Some(c), true) = (def.kind, &conv, connector.shows_typing()) {
            // what came in after the messages this reply answers is new to it
            let since: Option<DateTime<Utc>> = sqlx::query_scalar(
                "SELECT MAX(i.created_at) FROM db_pigeon_triage t JOIN db_pigeon_items i ON i.id = ANY(t.item_ids) WHERE t.id = $1",
            )
            .bind(p.triage_id)
            .fetch_one(&st.pool)
            .await?;
            let text = p.args["text"].as_str().unwrap_or_default();
            if let Some(why) = pace::before_send(st, connector.as_ref(), c.id, text, since.unwrap_or_else(Utc::now)).await? {
                sqlx::query("UPDATE db_pigeon_actions SET status = 'dropped', error = $2, decided_by = 'pigeon (auto)', decided_at = NOW(), updated_at = NOW() WHERE id = $1")
                    .bind(id)
                    .bind(format!("not sent: {why}"))
                    .execute(&st.pool)
                    .await?;
                log::info!("pigeon action {id}: auto reply not sent, {why}");
                return Ok(Outcome { id: Some(id), status: "cancelled".into(), detail: Some(why.into()) });
            }
        }
        let row = match execute(st, id, "pigeon (auto)").await {
            Ok(row) => row,
            // the user approved it while Pigeon was typing it: it went, theirs
            Err(e) => match get(st, id).await? {
                Some(row) if row.status != "pending" => row,
                _ => return Err(e),
            },
        };
        return Ok(Outcome { id: Some(id), status: row.status, detail: row.error });
    }
    Ok(Outcome { id: Some(id), status: "pending".into(), detail: hold })
}

/// The user wrote in this conversation themselves in the last 10 minutes (since they last resumed
/// auto there): Pigeon doesn't answer there, and nothing about it reaches their phone (they're in it).
pub async fn user_writing(st: &State, conversation: Uuid) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM db_pigeon_items WHERE conversation_id = $1 AND author = 'me' AND at > NOW() - make_interval(mins => $2)
             AND at > COALESCE((SELECT at FROM db_pigeon_auto_resumed WHERE conversation_id = $1), '-infinity'))",
    )
    .bind(conversation)
    .bind(QUIET_AFTER_ME_MINUTES as i32)
    .fetch_one(&st.pool)
    .await?)
}

/// Whether the user wrote in this conversation themselves in the last `minutes`.
pub async fn wrote_within(st: &State, conversation: Uuid, minutes: i32) -> anyhow::Result<bool> {
    Ok(sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM db_pigeon_items WHERE conversation_id = $1 AND author = 'me' AND at > NOW() - make_interval(mins => $2))")
        .bind(conversation)
        .bind(minutes)
        .fetch_one(&st.pool)
        .await?)
}

/// When Pigeon may answer again in a conversation the user is writing in: 10 minutes after their
/// last message there. None when they aren't.
pub async fn quiet_until(st: &State, conversation: Uuid) -> anyhow::Result<Option<DateTime<Utc>>> {
    Ok(sqlx::query_scalar(
        "SELECT MAX(at) + make_interval(mins => $2) FROM db_pigeon_items WHERE conversation_id = $1 AND author = 'me'
           AND at > COALESCE((SELECT at FROM db_pigeon_auto_resumed WHERE conversation_id = $1), '-infinity')
         HAVING MAX(at) + make_interval(mins => $2) > NOW()",
    )
    .bind(conversation)
    .bind(QUIET_AFTER_ME_MINUTES as i32)
    .fetch_optional(&st.pool)
    .await?
    .flatten())
}

/// New messages came in: what Pigeon proposed before them, still waiting (replies, tasks,
/// events), is stale; the round that reads them proposes again what's still needed.
pub async fn supersede_proposals(st: &State, conversation: Uuid) -> anyhow::Result<Vec<Uuid>> {
    Ok(sqlx::query_scalar(
        "UPDATE db_pigeon_actions SET status = 'expired', error = 'replaced: new messages came in', updated_at = NOW()
          WHERE conversation_id = $1 AND status = 'pending' AND source = 'agent' RETURNING id",
    )
    .bind(conversation)
    .fetch_all(&st.pool)
    .await?)
}

/// The user lets auto replies answer again now in these conversations: the wait after they wrote
/// there themselves and the hourly count start over.
pub async fn resume_auto(st: &State, conversations: &[Uuid]) -> anyhow::Result<()> {
    sqlx::query(
        "INSERT INTO db_pigeon_auto_resumed (conversation_id, at) SELECT unnest($1::uuid[]), NOW()
         ON CONFLICT (conversation_id) DO UPDATE SET at = NOW()",
    )
    .bind(conversations)
    .execute(&st.pool)
    .await?;
    // what came in while he was writing there, unanswered: answered now
    sqlx::query(
        "UPDATE db_pigeon_conversations SET triage_due_at = NOW()
          WHERE id = ANY($1) AND last_in_at IS NOT NULL AND (triaged_at IS NULL OR last_in_at > triaged_at)",
    )
    .bind(conversations)
    .execute(&st.pool)
    .await?;
    Ok(())
}

/// Why an auto reply on this conversation must wait for the user, if it must.
async fn reply_guard(st: &State, c: &conversations::Conversation) -> anyhow::Result<Option<String>> {
    let now = Utc::now();
    if c.window_until.is_some_and(|w| w < now) {
        return Ok(Some("the channel's reply window has closed".into()));
    }
    if c.last_out_at.is_some_and(|t| now - t < chrono::Duration::minutes(QUIET_AFTER_ME_MINUTES)) && user_writing(st, c.id).await? {
        return Ok(Some("you're writing in this conversation yourself".into()));
    }
    let sent: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_pigeon_actions WHERE conversation_id = $1 AND kind = 'reply' AND policy = 'auto' AND status = 'done'
           AND decided_at > NOW() - INTERVAL '1 hour'
           AND decided_at > COALESCE((SELECT at FROM db_pigeon_auto_resumed WHERE conversation_id = $1), '-infinity')",
    )
    .bind(c.id)
    .fetch_one(&st.pool)
    .await?;
    if sent >= AUTO_REPLIES_PER_HOUR {
        return Ok(Some(format!("{sent} auto replies here in the last hour")));
    }
    Ok(None)
}

/// Run a pending action through its connector; it ends done or failed. Its row stays locked while
/// it runs: a second run of it (an auto reply the user approved while it was typing) waits, then
/// finds it done and runs nothing.
pub async fn execute(st: &State, id: Uuid, by: &str) -> anyhow::Result<ActionRow> {
    let mut tx = st.pool.begin().await?;
    let status: Option<String> = sqlx::query_scalar("SELECT status FROM db_pigeon_actions WHERE id = $1 FOR UPDATE").bind(id).fetch_optional(&mut *tx).await?;
    match status.as_deref() {
        None => anyhow::bail!("no action {id}"),
        Some("pending") => {}
        Some(s) => anyhow::bail!("action {id} is {s}, not pending"),
    }
    let row = get(st, id).await?.ok_or_else(|| anyhow::anyhow!("no action {id}"))?;
    let result = match connectors::find(st, &row.connector) {
        Some(c) if c.available(st).is_ok() => c.run(st, &row.user_id, &row.action, &row.args, row.conversation_id).await,
        _ => Err(anyhow::anyhow!("connector {} is not available", row.connector)),
    };
    let (status, result, error) = match result {
        Ok(v) => ("done", Some(v), None),
        Err(e) => {
            log::warn!("pigeon action {id} ({}.{}) failed: {e:#}", row.connector, row.action);
            ("failed", None, Some(format!("{e:#}")))
        }
    };
    sqlx::query(
        "UPDATE db_pigeon_actions SET status = $2, result = $3, error = $4, decided_by = COALESCE(decided_by, $5), decided_at = COALESCE(decided_at, NOW()),
                updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(&result)
    .bind(&error)
    .bind(by)
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    if status == "done" && row.kind == "reply" {
        if let Some(c) = row.conversation_id {
            sqlx::query("UPDATE db_pigeon_conversations SET attention = NULL, needs_note = NULL, handled_at = NOW() WHERE id = $1").bind(c).execute(&st.pool).await?;
        }
    }
    if let Some(c) = row.conversation_id {
        crate::apps::pigeon::events::conversation(&st.pool, c).await;
    }
    Ok(get(st, id).await?.expect("the row just updated"))
}

/// The user's yes, optionally with new arguments (an edited reply): replaces the ones given.
pub async fn approve(st: &State, id: Uuid, edits: Option<&Json>, by: &str) -> anyhow::Result<ActionRow> {
    let row = get(st, id).await?.ok_or_else(|| anyhow::anyhow!("no action {id}"))?;
    if row.status != "pending" {
        anyhow::bail!("action {id} is {}, not pending", row.status);
    }
    if row.expires_at.is_some_and(|e| e < Utc::now()) {
        expire_due(st).await?;
        anyhow::bail!("action {id} has expired");
    }
    let mut args = row.args.clone();
    if let (Some(Json::Object(edits)), Some(obj)) = (edits, args.as_object_mut()) {
        for (k, v) in edits {
            obj.insert(k.clone(), v.clone());
        }
    }
    sqlx::query("UPDATE db_pigeon_actions SET args = $2, decided_by = $3, decided_at = NOW(), updated_at = NOW() WHERE id = $1")
        .bind(id)
        .bind(&args)
        .bind(by)
        .execute(&st.pool)
        .await?;
    execute(st, id, by).await
}

/// A waiting draft's new words: it stays a draft.
pub async fn redraft(st: &State, id: Uuid, text: &str) -> anyhow::Result<ActionRow> {
    let n = sqlx::query(
        "UPDATE db_pigeon_actions SET args = jsonb_set(args, '{text}', to_jsonb($2::text)), updated_at = NOW()
          WHERE id = $1 AND status = 'pending' AND kind = 'reply'",
    )
    .bind(id)
    .bind(text)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if n == 0 {
        anyhow::bail!("action {id} isn't a waiting draft");
    }
    let row = get(st, id).await?.expect("the row just updated");
    match row.conversation_id {
        Some(c) => crate::apps::pigeon::events::conversation(&st.pool, c).await,
        None => crate::apps::pigeon::events::publish(&st.pool, &row.user_id, "news", None).await,
    }
    Ok(row)
}

pub async fn drop(st: &State, id: Uuid, by: &str, why: Option<&str>) -> anyhow::Result<ActionRow> {
    let n = sqlx::query(
        "UPDATE db_pigeon_actions SET status = 'dropped', decided_by = $2, decided_at = NOW(), error = $3, updated_at = NOW()
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(id)
    .bind(by)
    .bind(why)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if n == 0 {
        anyhow::bail!("action {id} is not pending");
    }
    Ok(get(st, id).await?.expect("the row just updated"))
}

/// The user asked Piuma for it (a message to someone): theirs, waiting for their tap on the draft
/// (`ask`), never sent from the chat itself.
pub async fn queue(st: &State, user: &str, connector: &str, action: &str, args: Json, conversation: Option<Uuid>, reason: &str) -> anyhow::Result<Uuid> {
    let def = connectors::find(st, connector)
        .filter(|c| c.available(st).is_ok())
        .and_then(|c| c.actions().into_iter().find(|a| a.name == action))
        .ok_or_else(|| anyhow::anyhow!("no action {connector}.{action} here"))?;
    let days = if def.kind == Kind::Reply { REPLY_EXPIRES_DAYS } else { OTHER_EXPIRES_DAYS };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_pigeon_actions (user_id, conversation_id, connector, action, kind, args, status, source, policy, reason, expires_at)
         VALUES ($8, $1, $2, $3, $4, $5, 'pending', 'piuma', 'ask', $6, NOW() + make_interval(days => $7)) RETURNING id",
    )
    .bind(conversation)
    .bind(connector)
    .bind(action)
    .bind(def.kind.as_str())
    .bind(&args)
    .bind(reason)
    .bind(days as i32)
    .bind(user)
    .fetch_one(&st.pool)
    .await?;
    if let Some(c) = conversation {
        crate::apps::pigeon::events::conversation(&st.pool, c).await;
    }
    Ok(id)
}

/// The user does an action themselves: no policy, logged as theirs.
pub async fn direct(st: &State, user: &str, connector: &str, action: &str, args: Json, conversation: Option<Uuid>, by: &str) -> anyhow::Result<ActionRow> {
    run_now(st, user, connector, action, args, conversation, Source::User, "direct", by, None).await
}

/// Log an action as decided and run it at once: the user's own (`direct`), or a rule's step
/// (policy `auto`, or `ask` once they approved the run).
#[allow(clippy::too_many_arguments)]
pub async fn run_now(
    st: &State,
    user: &str,
    connector: &str,
    action: &str,
    args: Json,
    conversation: Option<Uuid>,
    source: Source,
    policy: &str,
    by: &str,
    reason: Option<&str>,
) -> anyhow::Result<ActionRow> {
    let def = connectors::find(st, connector)
        .and_then(|c| c.actions().into_iter().find(|a| a.name == action))
        .ok_or_else(|| anyhow::anyhow!("no action {connector}.{action}"))?;
    if def.on_conversation && conversation.is_none() {
        anyhow::bail!("{connector}.{action} needs conversation_id");
    }
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_pigeon_actions (user_id, conversation_id, connector, action, kind, args, status, source, policy, reason, decided_by, decided_at)
         VALUES ($10, $1, $2, $3, $4, $5, 'pending', $6, $7, $8, $9, NOW()) RETURNING id",
    )
    .bind(conversation)
    .bind(connector)
    .bind(action)
    .bind(def.kind.as_str())
    .bind(&args)
    .bind(source.as_str())
    .bind(policy)
    .bind(reason)
    .bind(by)
    .bind(user)
    .fetch_one(&st.pool)
    .await?;
    execute(st, id, by).await
}

/// Pending actions past their time become expired.
pub async fn expire_due(st: &State) -> anyhow::Result<u64> {
    Ok(sqlx::query(
        "UPDATE db_pigeon_actions SET status = 'expired', error = COALESCE(error, 'nobody decided in time'), updated_at = NOW()
          WHERE status = 'pending' AND expires_at < NOW()",
    )
    .execute(&st.pool)
    .await?
    .rows_affected())
}

/// A row as Piuma and the Inbox see it.
pub fn view(row: &ActionRow) -> Json {
    json!({
        "id": row.id,
        "conversation_id": row.conversation_id,
        "action": connectors::tool_name(&row.connector, &row.action),
        "kind": row.kind,
        "args": row.args,
        "status": row.status,
        "source": row.source,
        "policy": row.policy,
        "reason": row.reason,
        "decided_by": row.decided_by,
        "decided_at": row.decided_at,
        "result": row.result,
        "error": row.error,
        "expires_at": row.expires_at,
        "created_at": row.created_at,
    })
}

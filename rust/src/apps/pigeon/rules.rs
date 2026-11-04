//! Rules: what the user wants done with what a sender keeps sending (a bank's alerts, receipts,
//! a repository's PR mail), without the agent. A rule matches items by connector (or any: `*`),
//! sender (an address, or @domain) and/or person (a contact, on whichever of their handles),
//! words in the subject, and who else a message went to (`Recipients`); Jev then checks, in the item's triage call,
//! that the item is what the rule `expects` (the same sender may send something else: a warning,
//! a problem, a person writing). Sure → the rule's steps; unsure → the steps wait for the user;
//! not it → skipped, and the item is triaged like any other.
//!
//! A rule's steps: `record_tool` (a connector action, e.g. vault_log), its arguments filled in by
//! the LLM from the item following the rule's instructions, then `then_action` (mark read,
//! archive, trash) on that one message. They run in order, each logged as an action (source
//! rule); a failed step stops the rest, so a message is never trashed before it was recorded.

use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Map, Value as Json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::pigeon::ai::{jev, llm};
use crate::apps::pigeon::connectors::{self, Kind};
use crate::apps::pigeon::actions::{self, Source};
use crate::apps::pigeon::conversations::{self, Item};
use crate::apps::pigeon::{cards, owner, policy};
use crate::apps::pigeon::state::State;

/// Jev this sure that an item is what the rule expects: the steps run (under auto).
pub const RUN_AT: f64 = 0.8;
/// Below it the rule is skipped; between the two the steps wait for the user.
pub const ASK_AT: f64 = 0.5;
/// A pending run expires after this.
const EXPIRES_DAYS: i64 = 7;
pub const THEN: &[&str] = &["none", "mark_read", "archive", "trash"];

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Rule {
    pub id: i32,
    pub user_id: String,
    pub name: String,
    pub connector: String,
    pub sender: Option<String>,
    pub contact_id: Option<Uuid>,
    pub recipients: Option<sqlx::types::Json<Recipients>>,
    pub subject_has: Option<String>,
    pub expects: String,
    pub record_tool: Option<String>,
    pub record_instructions: Option<String>,
    pub then_action: String,
    pub mode: String,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

/// Conditions on who a message went to (email: to and cc), each optional.
#[derive(Debug, Clone, Default, PartialEq, Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Recipients {
    /// where the user is: `to` (among the To), `cc` (copied, not in To), `any`
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub you_are: Option<String>,
    /// one of these (addresses, or @domains) is among the recipients too
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub with: Vec<String>,
    /// true: to them alone; false: others are on it too
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub alone: Option<bool>,
}

impl Recipients {
    pub fn is_empty(&self) -> bool {
        self.you_are.as_deref().is_none_or(|y| y == "any") && self.with.is_empty() && self.alone.is_none()
    }

    pub fn check(&self) -> anyhow::Result<()> {
        if let Some(y) = &self.you_are {
            if !["to", "cc", "any"].contains(&y.as_str()) {
                anyhow::bail!("recipients.you_are: to, cc or any");
            }
        }
        if self.with.iter().any(|w| w.trim().is_empty() || w.contains(char::is_whitespace)) {
            anyhow::bail!("recipients.with: addresses or @domains");
        }
        Ok(())
    }

    /// Whether the item's recipients meet the conditions; `me` are the user's own addresses.
    pub fn met(&self, it: &Item, me: &[String]) -> bool {
        let list = |v: &Json| -> Vec<String> { v.as_array().into_iter().flatten().filter_map(Json::as_str).map(str::to_lowercase).collect() };
        let (to, cc) = (list(&it.to_addrs), list(&it.cc_addrs));
        let mine = |a: &String| me.iter().any(|m| m.eq_ignore_ascii_case(a));
        let you_ok = match self.you_are.as_deref() {
            Some("to") => to.iter().any(mine),
            Some("cc") => !to.iter().any(mine) && cc.iter().any(mine),
            _ => true,
        };
        let sender = it.sender.as_deref().unwrap_or_default().to_lowercase();
        let others: Vec<&String> = to.iter().chain(cc.iter()).filter(|a| !mine(a) && **a != sender).collect();
        let with_ok = self.with.is_empty()
            || self.with.iter().any(|w| {
                let w = w.trim().to_lowercase();
                others.iter().any(|a| if w.starts_with('@') { a.ends_with(&w) } else { **a == w })
            });
        let alone_ok = self.alone.is_none_or(|alone| alone == others.is_empty());
        you_ok && with_ok && alone_ok
    }
}

pub const RULE_COLS: &str =
    "id, user_id, name, connector, sender, contact_id, recipients, subject_has, expects, record_tool, record_instructions, then_action, mode, created_at, updated_at";
/// A rule's connector that means any channel.
pub const ANY: &str = "*";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Run {
    pub id: Uuid,
    pub rule_id: i32,
    pub item_id: Uuid,
    pub conversation_id: Uuid,
    pub matched: Option<f32>,
    pub status: String,
    pub reason: Option<String>,
    pub steps: Json,
    pub results: Json,
    pub error: Option<String>,
    pub decided_by: Option<String>,
    pub decided_at: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
}

const RUN_COLS: &str = "id, rule_id, item_id, conversation_id, matched, status, reason, steps, results, error, decided_by, decided_at, created_at";

/// One planned step: a connector action and its arguments.
#[derive(Debug, Clone, Serialize, serde::Deserialize)]
pub struct Step {
    pub connector: String,
    pub action: String,
    pub args: Json,
    /// runs on the item's conversation (archive, trash)
    #[serde(default)]
    pub on_conversation: bool,
}

pub async fn get(st: &State, id: i32) -> anyhow::Result<Option<Rule>> {
    Ok(sqlx::query_as(&format!("SELECT {RULE_COLS} FROM db_pigeon_rules WHERE id = $1")).bind(id).fetch_optional(&st.pool).await?)
}

/// One of the user's rules.
pub async fn mine(st: &State, user: &str, id: i32) -> anyhow::Result<Rule> {
    get(st, id).await?.filter(|r| r.user_id == user).ok_or_else(|| anyhow::anyhow!("no such rule: {id}"))
}

pub async fn list(st: &State, user: &str) -> anyhow::Result<Vec<Rule>> {
    Ok(sqlx::query_as(&format!("SELECT {RULE_COLS} FROM db_pigeon_rules WHERE user_id = $1 ORDER BY name")).bind(user).fetch_all(&st.pool).await?)
}

/// The user a rule run is for.
pub async fn run_owner(st: &State, id: Uuid) -> anyhow::Result<Option<String>> {
    Ok(sqlx::query_scalar("SELECT r.user_id FROM db_pigeon_rule_runs rr JOIN db_pigeon_rules r ON r.id = rr.rule_id WHERE rr.id = $1")
        .bind(id)
        .fetch_optional(&st.pool)
        .await?)
}

pub async fn get_run(st: &State, id: Uuid) -> anyhow::Result<Option<Run>> {
    Ok(sqlx::query_as(&format!("SELECT {RUN_COLS} FROM db_pigeon_rule_runs WHERE id = $1")).bind(id).fetch_optional(&st.pool).await?)
}

pub async fn runs(st: &State, user: &str, rule: Option<i32>, status: Option<&str>, limit: i64) -> anyhow::Result<Vec<Run>> {
    Ok(sqlx::query_as(&format!(
        "SELECT {RUN_COLS} FROM db_pigeon_rule_runs
          WHERE rule_id IN (SELECT id FROM db_pigeon_rules WHERE user_id = $4)
            AND ($1::int IS NULL OR rule_id = $1) AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC LIMIT $3"
    ))
    .bind(rule)
    .bind(status)
    .bind(limit)
    .bind(user)
    .fetch_all(&st.pool)
    .await?)
}

/// Whether the rule's channel, sender, person, subject and recipients match the item (Jev
/// decides the rest). `contact` is who the item's conversation is with, `me` the user's own
/// addresses.
pub fn matches(r: &Rule, connector: &str, contact: Option<Uuid>, me: &[String], it: &Item) -> bool {
    if r.mode == "paused" || (r.connector != ANY && r.connector != connector) || it.direction != "in" {
        return false;
    }
    let sender = it.sender.as_deref().unwrap_or_default().to_lowercase();
    let sender_ok = match r.sender.as_deref().map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()) {
        Some(want) if want.starts_with('@') => sender.ends_with(&want),
        Some(want) => sender == want,
        None => true,
    };
    let contact_ok = r.contact_id.is_none() || r.contact_id == contact;
    let subject_ok = match r.subject_has.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(w) => it.subject.as_deref().unwrap_or_default().to_lowercase().contains(&w.to_lowercase()),
        None => true,
    };
    let recipients_ok = r.recipients.as_ref().is_none_or(|c| c.met(it, me));
    sender_ok && contact_ok && subject_ok && recipients_ok
}

/// The rules (not paused) that could apply to each of these items of one conversation.
pub async fn candidates(st: &State, user: &str, connector: &str, contact: Option<Uuid>, items: &[Item]) -> anyhow::Result<Vec<(Rule, Item)>> {
    let rules = list(st, user).await?;
    let me = conversations::my_handles(&st.pool, user).await?;
    let mut out = Vec::new();
    for it in items {
        // the first rule that matches an item is its rule
        if let Some(r) = rules.iter().find(|r| matches(r, connector, contact, &me, it)) {
            out.push((r.clone(), it.clone()));
        }
    }
    Ok(out)
}

/// Jev's question for one rule and one item of the batch.
pub fn question(r: &Rule, it: &Item) -> Json {
    jev::noul(&format!(
        "Is the message of {} from {} (subject \"{}\") {}? Answer no for anything else from the same sender: a warning, a \
         problem with an account, a person writing, a different kind of message.",
        it.at.format("%Y-%m-%d %H:%M UTC"),
        it.sender.as_deref().unwrap_or("?"),
        it.subject.as_deref().unwrap_or(""),
        r.expects.trim_end_matches('.')
    ))
}

/// The item, as the LLM reads it to fill a step in: its date in the user's time.
fn message_text(me: &owner::Owner, it: &Item) -> String {
    format!(
        "From: {}{}\nSubject: {}\nDate: {} ({}'s time, {})\n\n{}",
        it.sender_name.as_deref().map(|n| format!("{n} ")).unwrap_or_default(),
        it.sender.as_deref().map(|a| format!("<{a}>")).unwrap_or_default(),
        it.subject.as_deref().unwrap_or(""),
        me.local(it.at).format("%Y-%m-%d %H:%M"),
        me.name,
        me.tz,
        conversations::clip(&it.body, 8000)
    )
}

/// The rule's steps for this item (on `connector`): its record step (arguments from the LLM),
/// then its action on the message, where the channel has it.
pub async fn plan(st: &State, r: &Rule, connector: &str, it: &Item) -> anyhow::Result<Vec<Step>> {
    let mut steps = Vec::new();
    if let Some(tool) = r.record_tool.as_deref().filter(|t| !t.is_empty()) {
        let (c, def) = connectors::by_tool_name(st, tool).ok_or_else(|| anyhow::anyhow!("{tool} isn't available"))?;
        let me = owner::get(&st.pool, &r.user_id).await;
        let schema = connectors::tool_schema(&def, false, &[]);
        let tools = [json!({ "type": "function", "function": { "name": tool, "description": def.description, "parameters": schema } })];
        let system = format!(
            "You file one message for {name}, following their rule. Call {tool} exactly once, with values taken from the \
             message. Never invent: where the message doesn't show a value, write ?. Dates and times as the message gives \
             them, in {name}'s time ({tz}) when you must convert. Keep their format exactly when the rule gives one.",
            name = me.name,
            tz = me.tz
        );
        let user = format!(
            "The rule: {}\nWhat it's for: {}\nTheir instructions: {}\n\nThe message:\n{}",
            r.name,
            r.expects,
            r.record_instructions.as_deref().unwrap_or("(none: use your judgement)"),
            message_text(&me, it)
        );
        let reply = llm::complete(&st.pool, &system, &user, &tools).await?;
        let call = reply.tool_calls.into_iter().find(|c| c.name == tool).ok_or_else(|| anyhow::anyhow!("the model didn't fill {tool} in"))?;
        // a step made of question marks records nothing: the message didn't show what the rule wants
        let unknown: usize = call.args.as_object().into_iter().flatten().filter_map(|(_, v)| v.as_str()).map(|v| v.matches('?').count()).sum();
        if unknown >= 3 {
            anyhow::bail!("the message doesn't show what the rule records ({unknown} values unknown)");
        }
        steps.push(Step { connector: c.id().to_string(), action: def.name.to_string(), args: call.args, on_conversation: def.on_conversation });
    }
    let can = connectors::find(st, connector).is_some_and(|c| c.actions().iter().any(|a| a.name == r.then_action && a.on_conversation));
    if r.then_action != "none" && can {
        let external: String = sqlx::query_scalar("SELECT external_id FROM db_pigeon_items WHERE id = $1").bind(it.id).fetch_one(&st.pool).await?;
        steps.push(Step {
            connector: connector.to_string(),
            action: r.then_action.clone(),
            args: json!({ "message_id": external }),
            on_conversation: true,
        });
    }
    Ok(steps)
}

/// What became of an item a rule met: true when the rule took it (done or waiting), false when
/// it didn't (skipped, or its steps couldn't be planned): then triage handles the item as usual.
pub async fn handle(st: &State, r: &Rule, connector: &str, it: &Item, conversation: Uuid, matched: f64) -> anyhow::Result<bool> {
    let insert = |status: &'static str, reason: String, steps: Json, error: Option<String>| {
        sqlx::query_scalar::<_, Uuid>(
            "INSERT INTO db_pigeon_rule_runs (rule_id, item_id, conversation_id, matched, status, reason, steps, error)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (rule_id, item_id) DO NOTHING RETURNING id",
        )
        .bind(r.id)
        .bind(it.id)
        .bind(conversation)
        .bind(matched as f32)
        .bind(status)
        .bind(reason)
        .bind(steps)
        .bind(error)
    };
    if matched < ASK_AT {
        insert("skipped", format!("Jev: not what the rule expects ({matched:.2})"), json!([]), None).fetch_optional(&st.pool).await?;
        return Ok(false);
    }
    let steps = match plan(st, r, connector, it).await {
        Ok(s) => s,
        Err(e) => {
            insert("failed", "its steps couldn't be filled in".into(), json!([]), Some(format!("{e:#}"))).fetch_optional(&st.pool).await?;
            log::warn!("rule {} on item {}: {e:#}", r.name, it.id);
            return Ok(false);
        }
    };
    let hold = if r.mode != "auto" {
        Some("the rule is on ask".to_string())
    } else if matched < RUN_AT {
        Some(format!("Jev isn't sure it's what the rule expects ({matched:.2})"))
    } else if !policy::auto_enabled(&st.pool, &r.user_id).await? {
        Some("auto is switched off".to_string())
    } else {
        None
    };
    let reason = hold.clone().unwrap_or_else(|| format!("Jev: it's what the rule expects ({matched:.2})"));
    let Some(id) = insert("pending", reason, serde_json::to_value(&steps)?, None).fetch_optional(&st.pool).await? else {
        return Ok(true); // met already
    };
    if hold.is_none() {
        execute(st, id, &format!("rule {} (auto)", r.name)).await?;
    } else if let Err(e) = cards::run_waiting(st, &r.user_id, conversation, id).await {
        log::warn!("the card of rule run {id}: {e:#}");
    }
    Ok(true)
}

/// Run a pending run's steps in order; a failed step stops the rest.
pub async fn execute(st: &State, id: Uuid, by: &str) -> anyhow::Result<Run> {
    let run = get_run(st, id).await?.ok_or_else(|| anyhow::anyhow!("no rule run {id}"))?;
    if run.status != "pending" {
        anyhow::bail!("rule run {id} is {}, not pending", run.status);
    }
    let rule = get(st, run.rule_id).await?.ok_or_else(|| anyhow::anyhow!("its rule is gone"))?;
    let steps: Vec<Step> = serde_json::from_value(run.steps.clone())?;
    let policy = if by.ends_with("(auto)") { "auto" } else { "ask" };
    let mut results = Vec::new();
    let mut error: Option<String> = None;
    for s in steps {
        let conv = s.on_conversation.then_some(run.conversation_id);
        let row = actions::run_now(st, &rule.user_id, &s.connector, &s.action, s.args, conv, Source::Rule, policy, by, Some(&format!("rule {}", rule.name))).await?;
        results.push(json!({ "action_id": row.id, "action": format!("{}_{}", row.connector, row.action), "status": row.status, "result": row.result }));
        if row.status != "done" {
            error = Some(row.error.unwrap_or_else(|| format!("{}_{} {}", row.connector, row.action, row.status)));
            break;
        }
    }
    let status = if error.is_some() { "failed" } else { "done" };
    sqlx::query(
        "UPDATE db_pigeon_rule_runs SET status = $2, results = $3, error = $4, decided_by = $5, decided_at = NOW(), updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .bind(status)
    .bind(Json::Array(results))
    .bind(&error)
    .bind(by)
    .execute(&st.pool)
    .await?;
    if let Some(e) = &error {
        log::warn!("rule {} run {id}: {e}", rule.name);
    }
    crate::apps::pigeon::events::conversation(&st.pool, run.conversation_id).await;
    get_run(st, id).await?.ok_or_else(|| anyhow::anyhow!("rule run {id} vanished"))
}

/// The user said no to a pending run: nothing happens to the message.
pub async fn drop(st: &State, id: Uuid, by: &str, why: Option<&str>) -> anyhow::Result<Run> {
    let n = sqlx::query(
        "UPDATE db_pigeon_rule_runs SET status = 'dropped', error = $3, decided_by = $2, decided_at = NOW(), updated_at = NOW()
          WHERE id = $1 AND status = 'pending'",
    )
    .bind(id)
    .bind(by)
    .bind(why)
    .execute(&st.pool)
    .await?
    .rows_affected();
    if n == 0 {
        anyhow::bail!("rule run {id} isn't pending");
    }
    let run = get_run(st, id).await?.ok_or_else(|| anyhow::anyhow!("rule run {id} vanished"))?;
    crate::apps::pigeon::events::conversation(&st.pool, run.conversation_id).await;
    Ok(run)
}

pub async fn expire_due(st: &State) -> anyhow::Result<u64> {
    Ok(sqlx::query(
        "UPDATE db_pigeon_rule_runs SET status = 'expired', error = 'nobody decided in time', updated_at = NOW()
          WHERE status = 'pending' AND created_at < NOW() - make_interval(days => $1)",
    )
    .bind(EXPIRES_DAYS as i32)
    .execute(&st.pool)
    .await?
    .rows_affected())
}

/// A run as the user reads it: the rule, the message, the steps.
pub async fn view(st: &State, run: &Run) -> anyhow::Result<Json> {
    let rule = get(st, run.rule_id).await?;
    let item: Option<(Option<String>, Option<String>, DateTime<Utc>)> =
        sqlx::query_as("SELECT sender, subject, at FROM db_pigeon_items WHERE id = $1").bind(run.item_id).fetch_optional(&st.pool).await?;
    let mut v = serde_json::to_value(run)?;
    v["rule"] = json!(rule.map(|r| r.name));
    if let Some((from, subject, at)) = item {
        v["message"] = json!({ "from": from, "subject": subject, "at": at });
    }
    v["kind"] = json!("rule_run");
    Ok(v)
}

/// The items a rule would have met among those Pigeon has (newest first), not met already:
/// with each, its conversation, channel and person.
async fn past_items(st: &State, r: &Rule, limit: i64) -> anyhow::Result<Vec<(Uuid, String, Item)>> {
    let rows: Vec<(Uuid, String, Option<Uuid>, Uuid)> = sqlx::query_as(
        "SELECT i.conversation_id, i.connector, c.contact_id, i.id FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
          WHERE c.user_id = $4 AND ($1 = '*' OR i.connector = $1) AND i.direction = 'in' AND ($3::uuid IS NULL OR c.contact_id = $3)
            AND NOT EXISTS (SELECT 1 FROM db_pigeon_rule_runs rr WHERE rr.rule_id = $2 AND rr.item_id = i.id)
          ORDER BY i.at DESC LIMIT 2000",
    )
    .bind(&r.connector)
    .bind(r.id)
    .bind(r.contact_id)
    .bind(&r.user_id)
    .fetch_all(&st.pool)
    .await?;
    let me = conversations::my_handles(&st.pool, &r.user_id).await?;
    let mut out = Vec::new();
    for (conv, connector, contact, id) in rows {
        let it = conversations::item(&st.pool, id).await?;
        if let Some(it) = it.filter(|it| matches(r, &connector, contact, &me, it)) {
            out.push((conv, connector, it));
            if out.len() as i64 >= limit {
                break;
            }
        }
    }
    Ok(out)
}

/// Try a rule on messages Pigeon has already: Jev's check and the steps, for each. With `apply`
/// the runs are made as if the messages had just come in (under ask they wait for the user).
pub async fn try_on_past(st: &State, r: &Rule, limit: i64, apply: bool) -> anyhow::Result<Json> {
    let jev = st.jev.as_ref().ok_or_else(|| anyhow::anyhow!("Jev isn't configured (PIGEON_JEV_*)"))?;
    let items = past_items(st, r, limit).await?;
    let name = owner::get(&st.pool, &r.user_id).await.name;
    let handles = conversations::my_handles(&st.pool, &r.user_id).await?;
    let mut out = Vec::new();
    for (conv, connector, it) in &items {
        let state = json!({ "channel": connector, "new_messages": conversations::transcript(std::slice::from_ref(it), "them", (&name, &handles), 3000) });
        let mut q = Map::new();
        q.insert("rule".into(), question(r, it));
        let matched = jev.ask(&state, q).await?.yes("rule").unwrap_or(0.0);
        let mut v = json!({ "message": { "channel": connector, "from": it.sender, "subject": it.subject, "at": it.at }, "matched": matched });
        if apply {
            handle(st, r, connector, it, *conv, matched).await?;
            let run: Option<Run> = sqlx::query_as(&format!("SELECT {RUN_COLS} FROM db_pigeon_rule_runs WHERE rule_id = $1 AND item_id = $2"))
                .bind(r.id)
                .bind(it.id)
                .fetch_optional(&st.pool)
                .await?;
            v["run"] = match run {
                Some(run) => view(st, &run).await?,
                None => Json::Null,
            };
        } else if matched >= ASK_AT {
            v["steps"] = match plan(st, r, connector, it).await {
                Ok(s) => serde_json::to_value(s)?,
                Err(e) => json!({ "error": format!("{e:#}") }),
            };
            v["would"] = json!(if r.mode == "auto" && matched >= RUN_AT { "run" } else { "wait for you" });
        } else {
            v["would"] = json!("skip: not what the rule expects");
        }
        out.push(v);
    }
    Ok(json!({ "rule": r.name, "applied": apply, "messages": out }))
}

/// A rule from the tool's arguments, checked: new (no id) or changing one.
pub struct RuleInput {
    pub name: String,
    pub connector: String,
    pub sender: Option<String>,
    pub contact_id: Option<Uuid>,
    pub recipients: Option<Recipients>,
    pub subject_has: Option<String>,
    pub expects: String,
    pub record_tool: Option<String>,
    pub record_instructions: Option<String>,
    pub then_action: String,
    pub mode: String,
}

pub fn check(st: &State, r: &RuleInput) -> anyhow::Result<()> {
    if r.name.trim().is_empty() || r.expects.trim().is_empty() {
        anyhow::bail!("name and expects are required");
    }
    if let Some(c) = &r.recipients {
        c.check()?;
    }
    if r.sender.is_none() && r.contact_id.is_none() {
        anyhow::bail!("a rule needs a sender, a person (contact_id), or both");
    }
    if let Some(s) = &r.sender {
        if s.contains(char::is_whitespace) || s.is_empty() {
            anyhow::bail!("sender is a handle: an address (bank@example.com), a domain (@example.com), a number");
        }
    }
    if r.connector != ANY && connectors::find(st, &r.connector).is_none() {
        anyhow::bail!("no connector {} (or * for any channel)", r.connector);
    }
    if !THEN.contains(&r.then_action.as_str()) {
        anyhow::bail!("then: none, mark_read, archive or trash");
    }
    // on one channel, it must have that action; on any, it's done where the channel has it
    if r.then_action != "none" && r.connector != ANY && connectors::find(st, &r.connector).is_some_and(|c| !c.actions().iter().any(|a| a.name == r.then_action)) {
        anyhow::bail!("{} can't {}", r.connector, r.then_action);
    }
    if !["ask", "auto", "paused"].contains(&r.mode.as_str()) {
        anyhow::bail!("mode: ask, auto or paused");
    }
    if let Some(t) = &r.record_tool {
        match connectors::by_tool_name(st, t) {
            Some((_, def)) if def.kind == Kind::Record && !def.on_conversation => {}
            Some(_) => anyhow::bail!("{t} doesn't record anything: use vault_log, vault_create_task or vault_create_event"),
            None => anyhow::bail!("{t} isn't an available tool"),
        }
    }
    Ok(())
}

pub async fn save(st: &State, user: &str, id: Option<i32>, r: &RuleInput) -> anyhow::Result<Rule> {
    check(st, r)?;
    if let Some(c) = r.contact_id {
        crate::apps::pigeon::people::mine(st, user, c).await?;
    }
    let sql = match id {
        None => format!(
            "INSERT INTO db_pigeon_rules (name, connector, sender, subject_has, expects, record_tool, record_instructions, then_action, mode, contact_id, recipients, user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING {RULE_COLS}"
        ),
        Some(_) => format!(
            "UPDATE db_pigeon_rules SET name = $1, connector = $2, sender = $3, subject_has = $4, expects = $5, record_tool = $6,
                    record_instructions = $7, then_action = $8, mode = $9, contact_id = $10, recipients = $11, updated_at = NOW()
              WHERE id = $13 AND user_id = $12 RETURNING {RULE_COLS}"
        ),
    };
    let mut q = sqlx::query_as::<_, Rule>(&sql)
        .bind(r.name.trim())
        .bind(&r.connector)
        .bind(r.sender.as_deref().map(|s| s.trim().to_lowercase()))
        .bind(&r.subject_has)
        .bind(r.expects.trim())
        .bind(&r.record_tool)
        .bind(&r.record_instructions)
        .bind(&r.then_action)
        .bind(&r.mode)
        .bind(r.contact_id)
        .bind(r.recipients.clone().filter(|c| !c.is_empty()).map(sqlx::types::Json))
        .bind(user);
    if let Some(id) = id {
        q = q.bind(id);
    }
    q.fetch_optional(&st.pool).await?.ok_or_else(|| anyhow::anyhow!("no such rule"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(sender: &str, subject: Option<&str>, mode: &str) -> Rule {
        Rule {
            id: 1,
            user_id: "u".into(),
            name: "r".into(),
            connector: "gmail".into(),
            sender: Some(sender.into()),
            contact_id: None,
            recipients: None,
            subject_has: subject.map(String::from),
            expects: "a receipt".into(),
            record_tool: None,
            record_instructions: None,
            then_action: "none".into(),
            mode: mode.into(),
            created_at: Utc::now(),
            updated_at: Utc::now(),
        }
    }

    fn item(sender: &str, subject: &str, direction: &str) -> Item {
        Item {
            id: Uuid::nil(),
            direction: direction.into(),
            author: "them".into(),
            sender: Some(sender.into()),
            sender_name: None,
            subject: Some(subject.into()),
            body: String::new(),
            media: json!([]),
            at: Utc::now(),
            created_at: Utc::now(),
            to_addrs: json!([]),
            cc_addrs: json!([]),
            reactions: serde_json::json!({}),
            open_url: None,
            via: None,
        }
    }

    fn matches_(r: &Rule, connector: &str, it: &Item) -> bool {
        matches(r, connector, None, &[], it)
    }

    #[test]
    fn recipients_conditions() {
        let me = vec!["me@gmail.com".to_string()];
        let mut it = item("boss@corp.com", "Plan", "in");
        it.to_addrs = json!(["luca@corp.com"]);
        it.cc_addrs = json!(["Me@gmail.com", "acc@tax.it"]);
        let c = |y: Option<&str>, with: &[&str], alone: Option<bool>| Recipients {
            you_are: y.map(String::from),
            with: with.iter().map(|s| s.to_string()).collect(),
            alone,
        };
        assert!(c(Some("cc"), &[], None).met(&it, &me), "only copied");
        assert!(!c(Some("to"), &[], None).met(&it, &me));
        assert!(c(None, &["@tax.it"], None).met(&it, &me), "the accountant is on it");
        assert!(!c(None, &["@other.it"], None).met(&it, &me));
        assert!(c(None, &[], Some(false)).met(&it, &me), "others on it");
        assert!(!c(None, &[], Some(true)).met(&it, &me));
        let mut one = item("boss@corp.com", "Plan", "in");
        one.to_addrs = json!(["me@gmail.com"]);
        assert!(c(Some("to"), &[], Some(true)).met(&one, &me), "to them alone");
        assert!(c(Some("any"), &[], None).is_empty() && !c(Some("cc"), &[], None).is_empty());
        assert!(c(Some("bcc"), &[], None).check().is_err());
    }

    #[test]
    fn a_rule_for_a_person_matches_them_on_any_channel() {
        let who = Uuid::from_u128(7);
        let mut r = rule("x@y.z", None, "auto");
        (r.sender, r.contact_id, r.connector) = (None, Some(who), ANY.into());
        let it = item("+66812345678", "", "in");
        assert!(matches(&r, "whatsapp", Some(who), &[], &it));
        assert!(matches(&r, "gmail", Some(who), &[], &item("them@x.com", "Hi", "in")));
        assert!(!matches(&r, "whatsapp", Some(Uuid::from_u128(8)), &[], &it), "someone else");
        assert!(!matches(&r, "whatsapp", None, &[], &it), "nobody known");
    }

    #[test]
    fn a_rule_matches_by_sender_domain_and_subject() {
        let it = item("no-reply@grab.com", "Your Grab E-Receipt", "in");
        assert!(matches_(&rule("no-reply@grab.com", None, "ask"), "gmail", &it));
        assert!(matches_(&rule("@grab.com", Some("e-receipt"), "auto"), "gmail", &it));
        assert!(!matches_(&rule("@grab.com", Some("refund"), "ask"), "gmail", &it), "subject words must be there");
        assert!(!matches_(&rule("@grab.com", None, "paused"), "gmail", &it), "a paused rule matches nothing");
        assert!(!matches_(&rule("@grab.com", None, "ask"), "whatsapp", &it), "another channel");
        assert!(!matches_(&rule("@ab.com", None, "ask"), "gmail", &item("x@grab.com.evil.io", "s", "in")));
        assert!(!matches_(&rule("@grab.com", None, "ask"), "gmail", &item("no-reply@grab.com", "s", "out")), "only what comes in");
    }
}

//! The agent: the LLM, offered the connectors' actions as tools, proposes what to do about a
//! conversation. It never acts: each tool call becomes a proposal that goes through its policy
//! (`actions`). Replies are written in the user's voice for that person on that channel: their
//! own past messages to them there are the examples, their note on them outranks everything, and
//! what Pigeon knows about them (`people`: their memory, the user's style with them on the
//! channel) carries the rest. The prompts call the user by their name (`owner`).
//!
//! A triage's round has two parts. The responder writes the reply to them (only that), unless
//! Jev's gate (`triage::gate`) keeps it for the user: the answer is theirs to give, or they ask
//! whether it's really the user. The intaker never writes to them: it turns the conversation into
//! tasks and events, and asks the user (`pigeon_ask_user`) what only they can answer, always when
//! the reply was kept for them; the answer brings Pigeon back (`after_answer`) to answer them as
//! the user said. What a round leaves for the user is cards in the Inbox (`cards::round`).
//!
//! What the user lets Pigeon tell the person (`tell`: where they are, whether they're free, what
//! they left for them) comes to the responder as the round's `tells`: it answers with them, the
//! reply carries their record (`args.used`), and goes on its own only when each was allowed on
//! its own and the reply, read back, says nothing more (`tell::leaks`).
//!
//! Where the user is, as a pin on the map (`Pin`): the model only asks for one (`pin` on the
//! reply), when the round may tell their exact spot or on the user's own word; the place is the
//! phone's (`facts::spot`), attached here, never a place the model read or wrote.
//!
//! Also here: the conversation summary (written when asked for and stale).

use std::collections::HashMap;
use std::sync::Arc;

use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::actions::{self, Outcome, Proposal, Source};
use crate::apps::pigeon::away::{self, Away};
use crate::apps::pigeon::ai::llm;
use crate::apps::pigeon::cards::{self, ASK_TOOL};
use crate::apps::pigeon::connectors::{self, ActionDef, Connector, Kind};
use crate::apps::pigeon::conversations::{self, Contact, Conversation};
use crate::apps::pigeon::facts;
use crate::apps::pigeon::owner::{self, Owner};
use crate::apps::pigeon::people;
use crate::apps::pigeon::policy::{self, Policy};
use crate::apps::pigeon::triage::{Signals, HOLD_AT};
use crate::apps::pigeon::state::State;
use crate::apps::pigeon::tell::{self, Use};
use crate::apps::telemetry::{Event, Severity};

/// The most actions one turn may propose.
const MAX_PROPOSALS: usize = 3;
/// The user's own messages to a person shown as examples of their voice.
const VOICE_EXAMPLES: i64 = 8;

enum Mode<'a> {
    /// After a triage: the responder (the reply to them) or the intaker (tasks, events, what to
    /// ask the user), under the policies.
    /// `tells`: what the responder may answer them with; `note`: what the intaker mustn't ask
    /// again (a 🔑 card is already open about it).
    AfterTriage { triage_id: i64, sig: &'a Signals, role: Role, held: Option<&'a str>, replied: Option<&'a str>, tells: &'a [Use], note: Option<&'a str> },
    /// The user (or Piuma for them) asked for a reply: reply actions only, always held for them.
    /// `compose`: the words come back for the user's box instead of a card
    Draft { instructions: Option<&'a str>, compose: bool },
    /// The user answered what Pigeon asked them: act on it (the reply, and an event or task it
    /// settles), under the policies.
    Answer { asked: &'a str, answer: &'a str },
    /// The user is away (`away`): Pigeon answers them itself, as Pigeon. `first`: its first
    /// message in this chat this away; `known`: someone the user writes to (they hear why).
    Away { triage_id: i64, sig: &'a Signals, away: &'a Away, first: bool, known: bool, tells: &'a [Use] },
    /// The user said to tell them (a 🔑 card): the reply with these, held for them like a draft.
    Tell { uses: &'a [Use] },
}

impl<'a> Mode<'a> {
    /// What this round may tell them of the user's.
    fn tells(&self) -> &'a [Use] {
        match self {
            Mode::AfterTriage { tells, .. } | Mode::Away { tells, .. } => tells,
            Mode::Tell { uses } => uses,
            _ => &[],
        }
    }
}

/// Why a round's reply may carry where the user is as a pin on the map.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pin {
    /// the person holds the user's exact spot, and asked
    Told,
    /// the user's own word: they asked for this reply, or answered Pigeon
    Asked,
}

/// What a reply's `pin` is, to the model.
fn pin_param(name: &str, pin: Pin) -> Json {
    let when = match pin {
        Pin::Told => format!("they ask where {name} is and the exact spot is what answers"),
        Pin::Asked => format!("{name}'s own words say to send their location"),
    };
    json!({ "type": "boolean", "description": format!(
        "true: {name}'s place right now goes with the reply as a pin on the map, attached by Pigeon from {name}'s phone (you          don't have it: never write coordinates, an address or a map link for it). Only when {when}. The text can then be          a few words, or empty."
    ) })
}

/// Who acts in an agent round.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum Role {
    /// writes the reply to them, and nothing else
    Responder,
    /// turns the conversation into tasks and events, and asks the user what only they can answer;
    /// never writes to them
    Intaker,
}

/// The responder after a triage: the reply to them (auto, or waiting for the user), with what
/// the user lets Pigeon tell them (`tells`).
pub async fn respond(st: &State, conversation: Uuid, triage_id: i64, sig: &Signals, tells: &[Use]) -> anyhow::Result<Vec<Outcome>> {
    run(st, conversation, Mode::AfterTriage { triage_id, sig, role: Role::Responder, held: None, replied: None, tells, note: None }).await
}

/// The intaker after a triage: `held` is why the reply was kept for the user (Jev's gate),
/// `replied` what became of the responder's reply, `note` what is already put to the user.
pub async fn intake(st: &State, conversation: Uuid, triage_id: i64, sig: &Signals, held: Option<&str>, replied: Option<&str>, note: Option<&str>) -> anyhow::Result<Vec<Outcome>> {
    run(st, conversation, Mode::AfterTriage { triage_id, sig, role: Role::Intaker, held, replied, tells: &[], note }).await
}

/// The away responder after a triage: Pigeon answers them as itself while the user is away
/// (`tells`: what it may tell them on its own).
pub async fn away_reply(st: &State, conversation: Uuid, triage_id: i64, sig: &Signals, away: &Away, tells: &[Use]) -> anyhow::Result<Vec<Outcome>> {
    let contact: Option<Uuid> = sqlx::query_scalar("SELECT contact_id FROM db_pigeon_conversations WHERE id = $1").bind(conversation).fetch_one(&st.pool).await?;
    let first = !away::answered_here(&st.pool, conversation, away).await?;
    let known = away::known(&st.pool, contact).await?;
    run(st, conversation, Mode::Away { triage_id, sig, away, first, known, tells }).await
}

pub async fn draft_reply(st: &State, conversation: Uuid, instructions: Option<&str>) -> anyhow::Result<Vec<Outcome>> {
    run(st, conversation, Mode::Draft { instructions, compose: false }).await
}

/// A reply's words for the user's own message box: written like a draft, proposed to nobody (no
/// card); they send it, or change it, themselves. None: Pigeon wrote none.
pub async fn compose_reply(st: &State, conversation: Uuid, instructions: Option<&str>) -> anyhow::Result<Option<String>> {
    let out = run(st, conversation, Mode::Draft { instructions, compose: true }).await?;
    Ok(out.into_iter().find(|o| o.status == "composed").and_then(|o| o.detail))
}

pub async fn after_answer(st: &State, conversation: Uuid, asked: &str, answer: &str) -> anyhow::Result<Vec<Outcome>> {
    // the reply written on the user's answer replaces one still waiting
    sqlx::query(
        "UPDATE db_pigeon_actions SET status = 'expired', error = 'replaced: your answer came in', updated_at = NOW()
          WHERE conversation_id = $1 AND status = 'pending' AND source = 'agent' AND kind = 'reply'",
    )
    .bind(conversation)
    .execute(&st.pool)
    .await?;
    run(st, conversation, Mode::Answer { asked, answer }).await
}

/// The user said to tell them (a 🔑 card's "answer this once", or what they just allowed): the
/// reply with it, as a draft they send.
pub async fn tell_reply(st: &State, conversation: Uuid, uses: &[Use]) -> anyhow::Result<Vec<Outcome>> {
    sqlx::query(
        "UPDATE db_pigeon_actions SET status = 'expired', error = 'replaced: you said to tell them', updated_at = NOW()
          WHERE conversation_id = $1 AND status = 'pending' AND source = 'agent' AND kind = 'reply'",
    )
    .bind(conversation)
    .execute(&st.pool)
    .await?;
    run(st, conversation, Mode::Tell { uses }).await
}

/// One agent round per conversation at a time (a triage and the user's answer to a question can come
/// together): the second waits and sees what the first did (its replies count for the auto limit).
fn conversation_lock(id: Uuid) -> Arc<tokio::sync::Mutex<()>> {
    static LOCKS: std::sync::LazyLock<std::sync::Mutex<HashMap<Uuid, Arc<tokio::sync::Mutex<()>>>>> = std::sync::LazyLock::new(Default::default);
    let mut locks = LOCKS.lock().expect("agent locks");
    // the ones nobody holds or waits for go
    locks.retain(|_, l| Arc::strong_count(l) > 1);
    locks.entry(id).or_default().clone()
}

/// Which actions a round may propose: replies, or everything else, or both.
fn offers(mode: &Mode<'_>, kind: Kind) -> bool {
    match mode {
        Mode::Draft { .. } => kind == Kind::Reply,
        Mode::AfterTriage { role: Role::Responder, .. } => kind == Kind::Reply,
        Mode::AfterTriage { role: Role::Intaker, .. } => kind != Kind::Reply,
        Mode::Answer { .. } => true,
        Mode::Away { .. } => kind == Kind::Reply,
        Mode::Tell { .. } => kind == Kind::Reply,
    }
}

async fn run(st: &State, id: Uuid, mode: Mode<'_>) -> anyhow::Result<Vec<Outcome>> {
    let started = std::time::Instant::now();
    let lock = conversation_lock(id);
    let _round = lock.lock().await;
    let conv = conversations::get(&st.pool, id).await?.ok_or_else(|| anyhow::anyhow!("no conversation {id}"))?;
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let me = owner::get(&st.pool, &conv.user_id).await;

    // the tools: this conversation's channel actions, and actions that aren't on a conversation
    // (the vault), the ones this round offers, minus what the policies switched off
    let drafting = matches!(mode, Mode::Draft { .. });
    // the user asked for this reply (a draft, or "tell them"): it comes to them whatever the policy
    let asked_for = drafting || matches!(mode, Mode::Tell { .. });
    let tells = mode.tells();
    let mut offered: Vec<(Arc<dyn Connector>, ActionDef)> = Vec::new();
    for (c, def) in connectors::available_actions(st) {
        if def.on_conversation && c.id() != conv.connector {
            continue;
        }
        if !def.agent || !offers(&mode, def.kind) {
            continue;
        }
        if policy::resolve(&st.pool, &conv.user_id, def.kind, conv.contact_id, Some(id)).await? == Policy::Off && !asked_for {
            continue;
        }
        offered.push((c, def));
    }
    // the intaker asks the user, unless they're writing there (they're in it)
    let asking = matches!(mode, Mode::AfterTriage { role: Role::Intaker, .. }) && !actions::user_writing(st, id).await?;
    if offered.is_empty() && !asking {
        return Ok(Vec::new());
    }
    let writes_reply = offered.iter().any(|(_, d)| d.kind == Kind::Reply);
    // away, Pigeon writes as itself: the user's voice isn't needed
    let away_mode = matches!(mode, Mode::Away { .. });
    let writes_reply_as_user = writes_reply && !away_mode;
    if asked_for {
        // the user waits on the button: what Pigeon knows as it stands, brought up to date behind
        people::catch_up_later(st, contact.as_ref(), &conv);
    } else if let Some(c) = &contact {
        // what Pigeon knows about them, and how the user writes to them here, brought up to date
        if let Err(e) = people::ensure_memory(st, c, false).await {
            log::warn!("memory of {}: {e:#}", c.id);
        }
        if writes_reply_as_user {
            if let Err(e) = people::ensure_style(st, c, &conv.connector, false).await {
                log::warn!("{} style of {}: {e:#}", conv.connector, c.id);
            }
        }
    } else if writes_reply_as_user {
        // a group: how the user writes in it
        if let Err(e) = people::ensure_group_style(st, &conv, false).await {
            log::warn!("style of group {}: {e:#}", conv.id);
        }
    }
    // a pin of where the user is: when this round may tell their exact spot, or on their own word
    let pin = if tells.iter().any(|u| u.tool == "location" && u.level == "exact") {
        Some(Pin::Told)
    } else if matches!(mode, Mode::Draft { compose: false, .. } | Mode::Answer { .. }) {
        Some(Pin::Asked)
    } else {
        None
    };
    let why = format!("Why, in one short sentence {} will read", me.name);
    let mut tools: Vec<Json> = offered
        .iter()
        .map(|(c, def)| {
            let mut params = connectors::tool_schema(def, false, &[("reason", &why)]);
            if let (Some(pin), Kind::Reply) = (pin, def.kind) {
                params["properties"]["pin"] = pin_param(&me.name, pin);
            }
            json!({ "type": "function", "function": {
                "name": connectors::tool_name(c.id(), def.name),
                "description": def.description,
                "parameters": params,
            }})
        })
        .collect();
    if asking {
        tools.push(json!({ "type": "function", "function": {
            "name": ASK_TOOL,
            "description": format!("Ask {me}, on their phone, something only they can answer about this conversation (whether to meet, \
                            a date or time, a price, a yes or no, a choice, what to tell them). The answer brings Pigeon back here \
                            to answer them as {me} said.", me = me.name),
            "parameters": { "type": "object", "properties": {
                "question": { "type": "string", "description": "In English, a few words, like a Slack message (the card already shows who and their message): \"dinner at hers Fri 6 Nov 20:00, bring dessert?\"" },
                "options": { "type": "array", "items": { "type": "string" }, "description": "2 to 4 answers as buttons, a word or three each (\"Yes\", \"Can't\", \"I'll answer\"); leave out for an open question" },
            }, "required": ["question"] },
        }}));
    }

    // their replies off: the user answers them, so Pigeon never asks what to tell them
    let replies_off = policy::resolve(&st.pool, &conv.user_id, Kind::Reply, conv.contact_id, Some(conv.id)).await? == Policy::Off;
    let system = system_prompt(&me, &mode, asking, replies_off, pin.is_some());
    let user = context(st, &me, &conv, contact.as_ref(), &mode, replies_off).await?;
    // the drafter (the user asked for a reply) may read the vault first; the auto responder and
    // the intaker never do: what they write can go out on its own
    let reply = if drafting {
        llm::complete_reading(&st.pool, &conv.user_id, &system, &user, &tools).await?
    } else {
        // a reply speaks as the user: the replies model
        let writer = if writes_reply_as_user { llm::Writer::Reply } else { llm::Writer::Other };
        llm::complete_as(&st.pool, writer, &system, &user, &tools).await?
    };

    let (triage_id, hold_reply) = match &mode {
        Mode::AfterTriage { triage_id, sig, .. } => (Some(*triage_id), hold_for(sig)),
        Mode::Draft { .. } | Mode::Tell { .. } => (None, Some(ASKED_AS_DRAFT.to_string())),
        Mode::Answer { .. } => (None, None),
        Mode::Away { triage_id, .. } => (Some(*triage_id), None),
    };
    let mut out = Vec::new();
    // one reply a round: a second is the same answer again
    let mut replied = false;
    let mut asked = false;
    for call in reply.tool_calls.into_iter().take(MAX_PROPOSALS + 1) {
        if asking && call.name == ASK_TOOL {
            let question = call.args["question"].as_str().unwrap_or_default().trim().to_string();
            if question.is_empty() || asked {
                continue;
            }
            asked = true;
            let options: Vec<String> = call.args["options"].as_array().into_iter().flatten().filter_map(|o| o.as_str().map(str::to_string)).collect();
            match cards::ask(st, id, &question, &options).await {
                Ok(qid) => out.push(Outcome { id: Some(qid), status: "asked".into(), detail: None }),
                Err(e) => log::warn!("agent on {id}: asking the user: {e:#}"),
            }
            continue;
        }
        let Some((c, def)) = offered.iter().find(|(c, d)| connectors::tool_name(c.id(), d.name) == call.name) else {
            log::warn!("agent on {id}: called {} which it wasn't offered", call.name);
            continue;
        };
        if def.kind == Kind::Reply {
            if replied {
                log::info!("agent on {id}: a second reply in one round, left");
                continue;
            }
            replied = true;
        }
        if let Mode::Draft { compose: true, .. } = mode {
            if let Some(text) = call.args["text"].as_str().map(str::trim).filter(|t| !t.is_empty()) {
                out.push(Outcome { id: None, status: "composed".into(), detail: Some(text.to_string()) });
                break;
            }
            continue;
        }
        let mut args = call.args;
        let reason = args.as_object_mut().and_then(|o| o.remove("reason")).and_then(|r| r.as_str().map(str::to_string));
        // the model asks for the pin; the place itself is the phone's, attached below
        let wants_pin = pin.is_some() && def.kind == Kind::Reply && args.get("pin").and_then(Json::as_bool) == Some(true);
        if let Some(o) = args.as_object_mut() {
            o.remove("conversation_id");
            // what Pigeon's code alone says of a reply (below, `actions`): never the model's to write
            for k in ["used", "used_auto", "as_written", "edited", "away", "pin", "place"] {
                o.remove(k);
            }
        }
        // away: Pigeon's mark before its words, and the reply known as an away one (it goes on its
        // own, and leaves the chat needing the user)
        if let (Mode::Away { first, .. }, Kind::Reply) = (&mode, def.kind) {
            let text = args["text"].as_str().map(str::trim).unwrap_or_default().to_string();
            if text.is_empty() {
                continue;
            }
            args["text"] = json!(format!("{}{text}", away::mark(&conv.connector, &me.name, *first)));
            args["away"] = json!(true);
        }
        let mut hold = if def.kind == Kind::Reply || drafting { hold_reply.clone() } else { None };
        // written with something of the user's: the reply carries what (the record), and goes on
        // its own only when each was allowed on its own and, read back, it says nothing more
        if def.kind == Kind::Reply && !tells.is_empty() {
            args["used"] = tell::record(tells);
            if hold.is_none() {
                let labels = tells.iter().map(|u| u.label.to_lowercase()).collect::<Vec<_>>().join(", ");
                let (on_its_own, also) = match &mode {
                    Mode::AfterTriage { .. } => (true, None),
                    Mode::Away { away, known, .. } => {
                        let why = if *known { format!(" ({})", away.reason) } else { String::new() };
                        (true, Some(format!("that {} is away right now{why}, when {} is back, and that Pigeon takes a message", me.name, me.name)))
                    }
                    _ => (false, None),
                };
                if on_its_own && tells.iter().all(|u| u.auto) {
                    let text = args["text"].as_str().unwrap_or_default();
                    // a pin alone has no words to say too much
                    let leak = if wants_pin && text.trim().is_empty() { None } else { tell::leaks(st, &conv, &me, tells, also.as_deref(), text).await };
                    match leak {
                        None => args["used_auto"] = json!(true),
                        Some(why) => hold = Some(format!("uses your {labels}: {why}")),
                    }
                } else {
                    hold = Some(format!("uses your {labels}: yours to send"));
                }
            }
        }
        // a point on the map written out is never Pigeon's to send on its own: where the user is
        // goes as a pin, from their phone (below), and a model can only have copied one
        if def.kind == Kind::Reply && hold.is_none() && has_coordinates(args["text"].as_str().unwrap_or_default()) {
            hold = Some("it gives a place as numbers: yours to send".to_string());
        }
        if wants_pin {
            let text = args["text"].as_str().map(str::trim).unwrap_or_default().to_string();
            match facts::spot(&st.pool, &conv.user_id).await? {
                Some(spot) => {
                    if hold.is_none() {
                        if spot.stale {
                            // an old place is the user's to send: they may be somewhere else by now
                            hold = Some(format!("your place is from {}: yours to send", me.local(spot.at).format("%a %H:%M")));
                        } else if let Mode::Answer { asked, answer } = &mode {
                            // on its own only when the user's answer plainly said to send it
                            if tell::asks_place(st, &conv, &me, asked, answer).await < tell::SURE_AT {
                                hold = Some("carries where you are: yours to send".to_string());
                            }
                        }
                    }
                    if c.sends_places() {
                        args["place"] = spot.json();
                    } else {
                        args["text"] = json!(if text.is_empty() { spot.link() } else { format!("{text}\n{}", spot.link()) });
                    }
                }
                None => {
                    let said = "📍 Pigeon can't send where you are: your phone hasn't told it. Switch your place on in the app (Settings > Access), then ask again.";
                    cards::news(st, &conv.user_id, Some(id), said, None, false).await;
                    if text.is_empty() {
                        continue;
                    }
                    // the words may promise a pin that isn't there
                    if hold.is_none() {
                        hold = Some("no place from your phone: it goes without the pin".to_string());
                    }
                }
            }
        }
        let p = Proposal {
            user_id: conv.user_id.clone(),
            conversation_id: Some(id),
            connector: c.id().to_string(),
            action: def.name.to_string(),
            args,
            reason,
            source: Source::Agent,
            triage_id,
            hold,
        };
        match actions::propose(st, p).await {
            Ok(o) => out.push(o),
            Err(e) => log::warn!("agent on {id}: proposing {}: {e:#}", call.name),
        }
    }
    if let Mode::Draft { instructions, compose } = &mode {
        // how long the user waited on the button (its model calls are `llm` events of their own)
        Event::new("pigeon", "draft", Severity::Info)
            .user_id(&conv.user_id)
            .entity("conversation", id)
            .duration(started.elapsed().as_millis().min(u32::MAX as u128) as u32)
            .attrs(json!({ "compose": compose, "told": instructions.is_some_and(|i| !i.trim().is_empty()), "wrote": !out.is_empty(), "channel": conv.connector }))
            .emit();
    }
    Ok(out)
}


/// Whether the words hold a point on the map as numbers ("12.34567, -98.76543"): two numbers of
/// three decimals or more, a comma between them, a latitude then a longitude.
fn has_coordinates(text: &str) -> bool {
    let b = text.as_bytes();
    // (where it starts, where it ends, its value)
    let mut nums: Vec<(usize, usize, f64)> = Vec::new();
    let mut i = 0;
    while i < b.len() {
        if !b[i].is_ascii_digit() {
            i += 1;
            continue;
        }
        let start = i;
        while i < b.len() && b[i].is_ascii_digit() {
            i += 1;
        }
        if i < b.len() && b[i] == b'.' {
            let decimals = i + 1;
            i = decimals;
            while i < b.len() && b[i].is_ascii_digit() {
                i += 1;
            }
            if i - decimals >= 3 {
                nums.push((start, i, text[start..i].parse().unwrap_or(f64::MAX)));
            }
        }
    }
    nums.windows(2).any(|w| {
        let between = text[w[0].1..w[1].0].trim();
        let between = between.strip_suffix('-').unwrap_or(between).trim();
        between == "," && w[0].2 <= 90.0 && w[1].2 <= 180.0
    })
}

/// The hold on what the user asked Pigeon to draft: it waits for their yes, and their Off doesn't
/// drop it (they asked).
pub const ASKED_AS_DRAFT: &str = "asked for as a draft";
/// Why a reply after this triage must wait for the user even under auto.
fn hold_for(sig: &Signals) -> Option<String> {
    if sig.sensitive >= HOLD_AT {
        Some(format!("sensitive ({:.2})", sig.sensitive))
    } else if sig.mood_changed >= HOLD_AT {
        Some(format!("the person seems upset or pressing ({:.2})", sig.mood_changed))
    } else if !sig.others.is_empty() {
        Some(format!("others are on it, and the reply goes to them too: {}", sig.others.join(", ")))
    } else {
        None
    }
}

fn system_prompt(me: &Owner, mode: &Mode<'_>, asking: bool, replies_off: bool, pin: bool) -> String {
    let now = me.now();
    let name = &me.name;
    let mut s = format!(
        "You are Pigeon, {name}'s intake assistant. Messages people send {name} reach you; you propose what to do \
         about them through the tools. You never act yourself: every tool call is a proposal {name} approves, unless \
         they told Pigeon to act on its own for that kind of action.\n\n\
         Now: {} ({name}'s time, {}, UTC{}). Write every date and time in that zone, as ISO 8601 with the offset.\n\n\
         Rules:\n\
         - Propose at most {MAX_PROPOSALS} actions, and only ones the conversation calls for. Proposing nothing is fine.\n\
         - Never invent facts, prices, dates or commitments {name} hasn't stated, and never agree on their behalf.\n\
         - Every call carries a `reason`: one short sentence in English that {name} will read.",
        now.format("%A %Y-%m-%d %H:%M"),
        me.tz,
        now.format("%:z"),
    );
    let replying = format!(
        "\n- A reply is written as {name}, in the first person, to this person (or this group): match the language, \
         dialect, length, tone, greetings and emoji use of {name}'s own messages there (the style and the examples), and \
         follow {name}'s note on them above all. One reply at most.\n\
         - Write it the way {name} would, not better: as long as {name}'s messages there usually are (the length given \
         below; never twice it), one thing only, the answer to the newest messages. No joke, pun or callback added on top, \
         no 'Ahah'/'Haha' opener, no exclamation runs, no summary or restating of the plan, no facts nobody asked about. \
         Emoji only as {name} uses them there (none if they don't). Plain and a little dry beats clever.\n\
         - A reply may acknowledge, thank, chat or ask, but accepting a request, a date, a price or a commitment is {name}'s \
         decision unless their own messages here already did, or their instructions say so: then propose no reply.\n\
         - Never claim to be {name} or a person, and never deny being Pigeon: when they ask or doubt whether it's really \
         {name}, propose no reply; that answer is {name}'s.\n\
         - A place, an address or coordinates in the conversation say where someone was when it was sent, not where \
         {name} is now: never give one as {name}'s place, and never write coordinates or a map link for where {name} is.{}",
        if pin {
            format!(
                " To send where {name} is now, set `pin` on the reply: Pigeon attaches the place from {name}'s phone, \
                 as a pin on the map."
            )
        } else {
            String::new()
        }
    );
    match mode {
        Mode::Away { away, first, known, .. } => {
            let why = if *known { format!(" ({})", away.reason) } else { String::new() };
            let back = match away.until {
                Some(u) => format!(", back around {} ({name}'s time)", me.local(u).format("%A %H:%M")),
                None => String::new(),
            };
            s.push_str(&format!(
                "\n\n{name} is away right now{why}{back}. While {name} is away you answer the people who write yourself, \
                 as Pigeon, {name}'s assistant: never as {name} and never in {name}'s name; you speak of {name} by name, in \
                 the third person.\n\
                 - Propose one reply at most, or none when the newest messages need no answer (an ok, a thank-you, an \
                 emoji, a goodbye).\n"
            ));
            if *first {
                let told = if *known {
                    format!("that {name} is away and why ({}), when {name} is back if it's known", away.reason)
                } else {
                    format!("that {name} isn't available right now (not why: they don't know them), when {name} is back if it's known")
                };
                s.push_str(&format!(
                    "- It's your first message to them while {name} is away: say {told}, and that you can take a message or \
                     note something for {name}; and answer what they wrote, if you can.\n"
                ));
            } else {
                s.push_str(&format!(
                    "- You already told them {name} is away (your messages above): don't say it again; answer what they write now.\n"
                ));
            }
            s.push_str(&format!(
                "- You may: take a message and say {name} will get it; say when {name} is back; ask one short question when \
                 you need a detail to note what they want (what, when, where).\n\
                 - Never agree, promise, accept or decline anything for {name} (a meeting, a date or time, a price, a favour, \
                 a plan): say {name} will see it when back. Never invent facts. Tell nothing about {name} beyond the above: \
                 not where {name} is, who with, plans, other people, or anything from past conversations.\n\
                 - Only when the context below says {name} is being alerted now, tell them it's been flagged to {name}.\n\
                 - Write in the language they write in: short (one to three sentences), warm and plain. No greeting \
                 signature and no name before your text: Pigeon's mark is added in front of it."
            ));
        }
        Mode::Draft { .. } => {
            s.push_str(&replying);
            s.push_str(&format!(
                "\n- {name} asked for a reply now: propose exactly one reply.\n\
                 - You are Pigeon's drafter: {name} reads your reply before it goes. Look things up in {name}'s vault (their \
                 notes, tasks and calendar, with the read tools: {reads}) only when the newest messages ask for a fact (when, \
                 where, what was agreed, an address) or {name}'s instructions ask you to; otherwise write straight away. Put in \
                 the reply only the fact that was asked, never the rest of what you found. Use only what this person should \
                 know: never pass on other people's private matters, credentials, money or health details unless {name}'s \
                 instructions ask for exactly that.",
                reads = llm::VAULT_READS.join(", ")
            ));
        }
        Mode::AfterTriage { role: Role::Responder, .. } => {
            s.push_str(&replying);
            s.push_str(&format!("\n- You only answer them: tasks, events and questions for {name} are handled by another part of Pigeon."));
        }
        Mode::AfterTriage { role: Role::Intaker, .. } => {
            s.push_str(&format!(
                "\n- You never write to them: the reply is another part of Pigeon's (what it did is below). You turn the \
                 conversation into what {name} must do or remember: a task when there is something to do or remember, \
                 an event when a date and time are agreed. Titles short and concrete. Don't propose what is already done or \
                 already waiting (below)."
            ));
            if asking && replies_off {
                s.push_str(&format!(
                    "\n- {name} answers this person themselves: never ask what to tell them, how to answer, or anything \
                     about replying. Call {ASK_TOOL} only for a task or an event the conversation leaves to {name} (a date or \
                     time to fix, something to do), with the question as {name} should read it on their phone. One question \
                     at most; usually none."
                ));
            } else if asking {
                s.push_str(&format!(
                    "\n- When something is {name}'s to decide or answer (whether to meet, a date or time, a price, a yes \
                     or no, a choice, what to tell them), call {ASK_TOOL} with the question as {name} should read it on their \
                     phone, with options when they're clear. Always ask when Pigeon kept the reply for {name} (below). Don't \
                     ask about what needs nothing from {name}. One question at most. When they ask whether it's really {name}, \
                     the options are that {name} answers them, or that Pigeon tells them it's {name}'s assistant; never that \
                     Pigeon says it's {name}."
                ));
            }
        }
        Mode::Tell { .. } => {
            s.push_str(&replying);
            s.push_str(&format!(
                "\n- {name} said to answer them with what is listed below (what {name} lets Pigeon tell them): propose exactly \
                 one reply that says it, as {name} would, and nothing more."
            ));
        }
        Mode::Answer { .. } => {
            s.push_str(&replying);
            s.push_str(&format!(
                "\n- {name} answered what Pigeon asked: act on the answer now. Reply to them as {name}, saying what the \
                 answer says and nothing it doesn't (no extra details, times or places); propose an event when the answer \
                 settles a date and time, a task when it leaves {name} something to do. If the answer says to do nothing, \
                 propose nothing. Even on the answer, never write that it's really {name} writing when it isn't."
            ));
        }
    }
    if !mode.tells().is_empty() {
        s.push_str(&format!(
            "\n- {name} lets Pigeon tell this person some things about {name}: what, and how far, is listed below (what {name} \
             lets Pigeon tell them). They asked for it: answer it with just that. Doing so isn't deciding for {name}, and it \
             comes before any rule above that says to tell nothing about {name}. Say only what answers what they asked: nothing \
             finer than what is listed, no guess beyond it, nothing else about {name}, and still no promise or plan in {name}'s name."
        ));
    }
    s
}

async fn context(st: &State, me: &Owner, conv: &Conversation, contact: Option<&Contact>, mode: &Mode<'_>, replies_off: bool) -> anyhow::Result<String> {
    let name = &me.name;
    let them = conversations::who(contact, conv);
    let handles = conversations::my_handles(&st.pool, &conv.user_id).await?;
    let items = conversations::recent_items(&st.pool, conv.id, 25).await?;
    let mut s = format!("Channel: {}\nConversation with: {them}\n", conv.connector);
    if let Some(t) = conv.title.as_deref().filter(|t| !t.is_empty()) {
        s.push_str(&format!("Subject/title: {t}\n"));
    }
    let away_mode = matches!(mode, Mode::Away { .. });
    if let Some(c) = contact {
        s.push_str(&c.facts(name));
        if let Some(note) = c.note.as_deref().filter(|n| !n.trim().is_empty()) {
            s.push_str(&format!("\n{name}'s note on {them} (follow it):\n{note}\n"));
        }
        if let Some(m) = people::memory(st, c.id).await? {
            s.push_str(&format!("\nWhat Pigeon knows about {them}, from their past conversations:\n{}\n", m.memory));
        }
        // the user's voice: not when Pigeon writes as itself (away)
        if !away_mode {
            if let Some(p) = people::style(st, c.id, &conv.connector).await? {
                s.push_str(&format!("\nHow {name} writes to {them} on {}:\n{}\n", conv.connector, p.profile));
            }
            let here = people::voice_examples(st, c.id, Some(&conv.connector), VOICE_EXAMPLES).await?;
            if !here.is_empty() {
                s.push_str(&format!("\n{name}'s own recent messages to {them} on {} (their voice):\n", conv.connector));
                for (_, e) in here {
                    s.push_str(&format!("- {}\n", conversations::clip(&e, 400)));
                }
            } else {
                // none on this channel yet: their messages elsewhere, for language and warmth, not form
                let elsewhere = people::voice_examples(st, c.id, None, VOICE_EXAMPLES).await?;
                if !elsewhere.is_empty() {
                    s.push_str(&format!(
                        "\n{name} hasn't written to {them} on {} yet. {name}'s messages to them elsewhere (match the language and \
                         warmth; the form on {} may differ):\n",
                        conv.connector, conv.connector
                    ));
                    for (ch, e) in elsewhere {
                        s.push_str(&format!("- [{ch}] {}\n", conversations::clip(&e, 400)));
                    }
                }
            }
        }
    }
    if contact.is_none() && !away_mode {
        // a group: how the user writes in it, and their latest messages there
        if let Some(p) = people::group_style(st, conv.id).await? {
            s.push_str(&format!("\nHow {name} writes in this group:\n{}\n", p.profile));
        }
        let here = people::chat_voice(st, conv.id, VOICE_EXAMPLES).await?;
        if !here.is_empty() {
            s.push_str(&format!("\n{name}'s own recent messages in this group (their voice):\n"));
            for e in here {
                s.push_str(&format!("- {}\n", conversations::clip(&e, 400)));
            }
        }
    }
    if let Some(n) = people::usual_length(st, conv.contact_id, conv.id, &conv.connector).await?.filter(|_| !away_mode) {
        s.push_str(&format!(
            "\n{name}'s messages here are usually about {n} characters long (half of them shorter): a reply stays near that, \
             never over {}.\n",
            (n * 2).max(40)
        ));
    }
    if let Some(w) = conv.window_until {
        s.push_str(&format!("\nThe channel accepts replies until {}.\n", me.local(w).format("%Y-%m-%d %H:%M")));
    }
    s.push_str(&format!("\nThe conversation (oldest first):\n{}", conversations::transcript(&items, &them, (name, &handles), 2000)));
    // what the user told Pigeon here lately: decided, never asked again
    let answers: Vec<(String, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT question, answer, answered_at FROM db_pigeon_questions
          WHERE conversation_id = $1 AND status = 'answered' AND answer IS NOT NULL AND answered_at > NOW() - INTERVAL '2 days'
            AND options->'uncovered' IS NULL
          ORDER BY answered_at DESC LIMIT 5",
    )
    .bind(conv.id)
    .fetch_all(&st.pool)
    .await?;
    if !answers.is_empty() {
        s.push_str(&format!(
            "\n{name} already answered Pigeon here (their decisions: follow them, and never ask {name} the same again; \
             what {them} wrote since, like \"so?\", is waiting for that answer):\n"
        ));
        for (q, a, at) in answers.iter().rev() {
            s.push_str(&format!("- {}: Pigeon asked \"{q}\", {name} answered \"{a}\"\n", me.local(*at).format("%Y-%m-%d %H:%M")));
        }
    }
    if !mode.tells().is_empty() {
        s.push_str(&tell::brief(mode.tells(), name, &them));
    }
    match mode {
        Mode::AfterTriage { sig, role, held, replied, note, .. } => {
            if *role == Role::Intaker {
                match (held, replied) {
                    _ if replies_off => s.push_str(&format!("\n{name} answers this person themselves (Pigeon doesn't reply to them).\n")),
                    (Some(why), _) => {
                        let why = if why.contains("really you") { format!("they ask whether it's really {name} writing") } else { format!("the answer is {name}'s to give") };
                        s.push_str(&format!("\nPigeon kept the reply to them for {name}: {why}. Ask.\n"))
                    }
                    (None, Some("done")) => s.push_str("\nPigeon has already replied to them (above, its message).\n"),
                    (None, Some("pending")) => s.push_str(&format!("\nPigeon wrote a reply that waits for {name}'s yes.\n")),
                    _ => s.push_str("\nPigeon proposed no reply to them.\n"),
                }
                if let Some(n) = note {
                    s.push_str(&format!("{n}\n"));
                }
                let waiting = actions::list(st, &conv.user_id, Some("pending"), Some(conv.id), 10).await?;
                if !waiting.is_empty() {
                    s.push_str(&format!("Already waiting for {name} here:\n"));
                    for w in waiting {
                        s.push_str(&format!("- {} {}\n", w.action, conversations::clip(&w.args.to_string(), 200)));
                    }
                }
                // what they decided lately: a task they took is done, one they dropped they don't want,
                // and neither comes back on the next message
                let decided = actions::decided_lately(st, conv.id, 7, 20).await?;
                let (taken, dropped): (Vec<_>, Vec<_>) = decided.iter().partition(|a| a.status == "done");
                if !taken.is_empty() {
                    s.push_str(&format!("{name} already took these here (done; don't propose them again):\n"));
                    for a in taken {
                        s.push_str(&format!("- {} {}\n", a.action, conversations::clip(&a.args.to_string(), 200)));
                    }
                }
                if !dropped.is_empty() {
                    s.push_str(&format!(
                        "{name} dropped these here (they don't want them: never propose them again, nor anything like them, \
                         unless the newest messages bring something new):\n"
                    ));
                    for a in dropped {
                        s.push_str(&format!("- {} {}\n", a.action, conversations::clip(&a.args.to_string(), 200)));
                    }
                }
            }
            s.push_str(&format!(
                "\nPigeon's triage of the newest messages: needs a reply {:.2}, written to {name} {:.2}, something to \
                 do or remember {:.2}, sensitive {:.2}, upset or pressing {:.2}, importance {:.2}, kind {}.\n",
                sig.needs_reply,
                sig.addressed,
                sig.actionable,
                sig.sensitive,
                sig.mood_changed,
                sig.importance,
                sig.kind.as_deref().unwrap_or("?")
            ));
            if !sig.others.is_empty() {
                s.push_str(&format!("Also on the newest messages, and copied on a reply: {}.\n", sig.others.join(", ")));
            }
        }
        Mode::Answer { asked, answer } => {
            s.push_str(&format!("\nPigeon asked {name}: {asked}\n{name}'s answer: {answer}\n"));
        }
        Mode::Tell { .. } => {
            s.push_str(&format!("\n{name} asks for a reply now that answers what {them} asked, with the above.\n"));
        }
        Mode::Away { sig, .. } => {
            if sig.urgent >= crate::apps::pigeon::triage::URGENT_AT {
                s.push_str(&format!("\nThis is urgent: {name} is being alerted now.\n"));
            }
            if !sig.others.is_empty() {
                s.push_str(&format!("Also on the newest messages: {}.\n", sig.others.join(", ")));
            }
        }
        Mode::Draft { instructions, .. } => {
            s.push_str(&format!("\n{name} asks for a reply to this conversation now."));
            if let Some(i) = instructions.filter(|i| !i.trim().is_empty()) {
                s.push_str(&format!(" Their instructions: {i}"));
            }
            s.push('\n');
        }
    }
    Ok(s)
}

/// The conversation's summary, written again when items arrived since.
pub async fn summary(st: &State, conv: &Conversation) -> anyhow::Result<Option<String>> {
    let fresh = matches!((conv.summary_at, conv.last_item_at), (Some(s), Some(l)) if s >= l);
    if fresh || conv.last_item_at.is_none() || !llm::available(&st.pool).await {
        return Ok(conv.summary.clone());
    }
    let me = owner::get(&st.pool, &conv.user_id).await;
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let them = conversations::who(contact.as_ref(), conv);
    let items = conversations::recent_items(&st.pool, conv.id, 40).await?;
    let handles = conversations::my_handles(&st.pool, &conv.user_id).await?;
    let text = llm::text_of(
        &st.pool,
        "summary",
        &format!(
            "Summarise a conversation for {name} in 2 to 4 short lines of English: what it is about, where it stands, \
             and anything open (questions to {name}, things {name} promised, dates). No preamble. \
             The messages' times are UTC; {name} is in {tz}. A day someone names from their own (today, tomorrow, tonight) \
             counts from that message's date there: write it as its date.",
            name = me.name,
            tz = me.tz
        ),
        &format!("Channel: {}\nWith: {them}\n\n{}", conv.connector, conversations::transcript(&items, &them, (&me.name, &handles), 1500)),
    )
    .await?;
    sqlx::query("UPDATE db_pigeon_conversations SET summary = $2, summary_at = NOW() WHERE id = $1").bind(conv.id).bind(&text).execute(&st.pool).await?;
    Ok(Some(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_written_out() {
        assert!(has_coordinates("12.34567,98.76543"));
        assert!(has_coordinates("I'm here: 12.34567, -98.76543 come"));
        assert!(has_coordinates("-12.345 , 98.765"));
        assert!(!has_coordinates("see you at 12.30, table for 2"));
        assert!(!has_coordinates("it's 12.50, or 13.25 with the drink"));
        assert!(!has_coordinates("call 345.1234567 or 333.7654321"));
        assert!(!has_coordinates("version 1.2.3456, 7.8.9012 next"));
        assert!(!has_coordinates("così è 12.345 e 98.765"));
        assert!(!has_coordinates(""));
    }
}

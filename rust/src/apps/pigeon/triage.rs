//! Triage: a conversation with new incoming items, once they've stopped arriving for the
//! debounce, gets one Jev call. Its answers set what the conversation needs from the user
//! (`attention`: reply, action, fyi, or nothing) and how much it matters; then the agent proposes
//! actions where something is needed. Jev's whole answer is stored, so the thresholds below can
//! be re-tuned on real traffic.

use serde_json::{json, Map};
use uuid::Uuid;

use crate::apps::pigeon::ai::jev;
use crate::apps::pigeon::{actions, agent, cards, conversations, owner, people, policy, rules};
use crate::apps::pigeon::state::{AppState, State};

pub const REPLY_AT: f64 = 0.6;
pub const ACTION_AT: f64 = 0.6;
/// Where only something surely to do is (Jev sure it's of low importance).
const SURE_ACTION_AT: f64 = 0.8;
pub const FYI_AT: f64 = 0.5;
pub const HOLD_AT: f64 = 0.5;
/// Urgent from here: its cards ring whatever the person's alert switch (`alerts`).
pub const URGENT_AT: f64 = 0.7;
/// Below this the new messages are written to someone else (the user only copied, or not the one
/// asked): nothing to reply to, at most worth knowing.
pub const ADDRESSED_AT: f64 = 0.5;
/// Below this importance (Jev sure it's low: a hotel's "we miss you"), only something surely to do
/// is something to do.
const LOW_IMPORTANCE: f64 = 0.2;
/// Kinds that never need the user, when Jev is this sure.
const NOISE: &[&str] = &["newsletter", "automated", "spam"];
const NOISE_AT: f64 = 0.6;

const IMPORTANCE: &[&str] = &["low", "medium", "high"];
const KINDS: &[(&str, Option<&str>)] = &[
    ("request", Some("asks {me} to do or send something")),
    ("question", Some("asks {me} something")),
    ("scheduling", Some("about meeting, a call, a date or a time")),
    ("money", Some("payments, invoices, prices, quotes")),
    ("social", Some("friends or family chatting, greetings, news")),
    ("update", Some("information for {me}, nothing asked")),
    ("newsletter", Some("a newsletter or marketing, a business inviting {me} back")),
    ("automated", Some("an automatic notification, receipt or alert")),
    ("spam", None),
];

/// What Jev said about one batch, as the agent and the safeguards read it.
#[derive(Debug, Clone, Default)]
pub struct Signals {
    pub needs_reply: f64,
    pub actionable: f64,
    pub sensitive: f64,
    pub mood_changed: f64,
    pub importance: f64,
    pub kind: Option<String>,
    /// written to the user themselves, not to others with them copied
    pub addressed: f64,
    /// other people on the new messages (to and cc, beyond the user and the sender): a reply
    /// goes to them too
    pub others: Vec<String>,
    /// the answer is the user's to give: whether to meet, a date, a price, a yes or no
    pub users_call: f64,
    /// they ask or doubt whether it's really the user writing
    pub doubts_user: f64,
    /// it can't wait: someone in trouble, something happening now
    pub urgent: f64,
}

/// Jev's gate on the reply: why Pigeon mustn't answer them on its own (the responder writes
/// nothing; the intaker puts it to the user), if it mustn't.
pub fn gate(sig: &Signals) -> Option<&'static str> {
    if sig.doubts_user >= HOLD_AT {
        Some("they ask if it's really you")
    } else if sig.users_call >= HOLD_AT {
        Some("your call")
    } else {
        None
    }
}

/// How long a triage holds its conversation: past it, a triage cut off (Pigeon restarted, a
/// deploy) is run again.
const LEASE_SECS: f64 = 300.0;
/// Triages run at once.
const AT_ONCE: usize = 4;

/// Every conversation whose triage is due, a few at once (an auto reply waits while it's paced
/// like a person's, `pace`: the others don't wait for it).
pub async fn run_due(st: &AppState) -> anyhow::Result<usize> {
    // leased, not taken off: a triage cut off before it ends comes back when the lease runs out
    let due: Vec<(Uuid, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "UPDATE db_pigeon_conversations SET triage_due_at = NOW() + make_interval(secs => $1)
          WHERE id IN (SELECT id FROM db_pigeon_conversations WHERE triage_due_at <= NOW() ORDER BY triage_due_at LIMIT 10 FOR UPDATE SKIP LOCKED)
          RETURNING id, triage_due_at",
    )
    .bind(LEASE_SECS)
    .fetch_all(&st.pool)
    .await?;
    let slots = std::sync::Arc::new(tokio::sync::Semaphore::new(AT_ONCE));
    let mut running = tokio::task::JoinSet::new();
    for (id, lease) in due.iter().copied() {
        let (st, slots) = (st.clone(), slots.clone());
        running.spawn_local(async move {
            let _slot = slots.acquire_owned().await;
            match triage(&st, id).await {
                Ok(()) => crate::apps::pigeon::health::ok("triage"),
                Err(e) => {
                    log::warn!("triage of {id}: {e:#}");
                    crate::apps::pigeon::health::failed("triage", format!("{e:#}"));
                }
            }
            // ended (a failure too: it doesn't loop every 5 s): off the queue, unless a new message
            // queued it again meanwhile
            if let Err(e) = sqlx::query("UPDATE db_pigeon_conversations SET triage_due_at = NULL WHERE id = $1 AND triage_due_at = $2")
                .bind(id)
                .bind(lease)
                .execute(&st.pool)
                .await
            {
                log::warn!("triage of {id}: {e:#}");
            }
        });
    }
    while running.join_next().await.is_some() {}
    Ok(due.len())
}

pub async fn triage(st: &State, id: Uuid) -> anyhow::Result<()> {
    let r = triage_inner(st, id).await;
    // the chat shows where it ended: replied · asked · nothing · stopped · failed; or, while the
    // user writes there, it waiting for them (until the round runs again)
    let outcome = match &r {
        Ok(o) => *o,
        Err(_) => "failed",
    };
    let again: Option<chrono::DateTime<chrono::Utc>> = if outcome == "paused" {
        sqlx::query_scalar("SELECT triage_due_at FROM db_pigeon_conversations WHERE id = $1").bind(id).fetch_one(&st.pool).await.ok().flatten()
    } else {
        None
    };
    match again {
        Some(at) => crate::apps::pigeon::events::working(&st.pool, id, "waiting", Some(at), None).await,
        None => crate::apps::pigeon::events::working(&st.pool, id, "done", None, Some(outcome)).await,
    }
    r.map(|_| ())
}

async fn triage_inner(st: &State, id: Uuid) -> anyhow::Result<&'static str> {
    // a voice note that just came in: its words first
    crate::apps::pigeon::listen::wait(st, id).await?;
    let started = chrono::Utc::now();
    let Some(conv) = conversations::get(&st.pool, id).await? else { return Ok("stopped") };
    let items = conversations::recent_items(&st.pool, id, 30).await?;
    // what came in since the last triage started (all of it, the first time; history brought in
    // on connect counts as seen), and since the last message written to them: what came before
    // it was answered (it stays in the earlier conversation, in its place)
    let last_out = items.iter().filter(|i| i.direction == "out").map(|i| i.at).max();
    let new: Vec<&conversations::Item> = items
        .iter()
        .filter(|i| i.direction == "in" && conv.triaged_at.map_or(true, |t| i.created_at > t) && last_out.map_or(true, |o| i.at > o))
        .collect();
    if new.is_empty() {
        return Ok("stopped");
    }
    crate::apps::pigeon::events::working(&st.pool, id, "analysing", None, None).await;
    // answered since (the user from their phone, while Pigeon held back): nothing left to do
    if items.last().is_some_and(|l| l.direction == "out") {
        sqlx::query("UPDATE db_pigeon_conversations SET triaged_at = $2 WHERE id = $1").bind(id).bind(started).execute(&st.pool).await?;
        log::info!("triage {id}: answered since, nothing to do");
        return Ok("stopped");
    }
    let Some(jev) = &st.jev else {
        // no AI: everything new is shown, nothing is judged
        sqlx::query("UPDATE db_pigeon_conversations SET attention = 'fyi', triaged_at = $2, handled_at = NULL WHERE id = $1")
            .bind(id)
            .bind(started)
            .execute(&st.pool)
            .await?;
        return Ok("nothing");
    };
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let them = conversations::who(contact.as_ref(), &conv);
    let owner = owner::get(&st.pool, &conv.user_id).await;
    let handles = conversations::my_handles(&st.pool, &conv.user_id).await?;
    let me = (owner.name.as_str(), handles.as_slice());
    let known = match &contact {
        Some(c) => people::memory(st, c.id).await?.map(|m| m.memory),
        None => None,
    };
    let new_ids: Vec<Uuid> = new.iter().map(|i| i.id).collect();
    let earlier: Vec<conversations::Item> = items.iter().filter(|i| !new_ids.contains(&i.id)).cloned().collect();
    let new_owned: Vec<conversations::Item> = new.iter().map(|i| (*i).clone()).collect();
    let state = json!({
        "channel": conv.connector,
        "with": them,
        "the_user": owner.name,
        "who_they_are_to_the_user": contact.as_ref().and_then(|c| c.relationship.clone()).unwrap_or_default(),
        "the_users_note_on_them": contact.as_ref().and_then(|c| c.note.clone()).unwrap_or_default(),
        "what_pigeon_knows_about_them": known.unwrap_or_default(),
        "earlier_in_the_conversation": conversations::transcript(&earlier, &them, me, 600),
        "new_messages": conversations::transcript(&new_owned, &them, me, 3000),
    });

    let mut q = Map::new();
    q.insert("needs_reply".into(), jev::noul(
        "Would {me} normally write back to the new messages? Yes for anything a person would answer: a question (small talk \
         too, like 'how are you?'), a greeting or news from a friend, a request. No for what closes the exchange (a thank-you, an \
         'ok', an emoji) and for anything automated (receipts, notifications, newsletters).",
    ));
    q.insert(
        "actionable".into(),
        jev::noul(
            "Do the new messages hold something {me} has to do or remember: a task, a deadline, a date, an appointment, a promise? \
             A business inviting {me} to come back, book, buy, review or rate is no.",
        ),
    );
    q.insert("sensitive".into(), jev::noul("Are the new messages about money, prices, contracts, commitments, health, a conflict or bad news, where a wrong reply would cost something?"));
    q.insert("mood_changed".into(), jev::noul("Is the person upset, annoyed, worried or pressing urgently in the new messages?"));
    q.insert(
        "users_call".into(),
        jev::noul(
            "Do the new messages wait for something only {me} can decide or know: whether to meet or call, a date or time, \
             a price or money, a yes or no to a request, a commitment, a choice, or a fact about {me}'s plans that the conversation \
             doesn't already settle? Small talk and greetings are no.",
        ),
    );
    q.insert(
        "doubts_user".into(),
        jev::noul("Do the new messages ask, or doubt, whether it's really {me} writing, or whether it's a bot, an AI, an assistant or an automatic reply?"),
    );
    q.insert(
        "urgent".into(),
        jev::noul(
            "Is it urgent for {me}, something that can't wait an hour or two: an emergency, someone hurt, ill or in \
             trouble, someone waiting for {me} right now (at the door, at the airport, a meeting starting), a plan changed for \
             today, a security or money alarm about {me}'s own accounts? Being pressing, or a deadline days away, is no.",
        ),
    );
    q.insert("importance".into(), jev::score("How important are the new messages for {me}?", IMPORTANCE));
    q.insert("kind".into(), jev::choice("What are the new messages mostly?", KINDS));
    q.insert(
        "addressed".into(),
        jev::noul(
            "Are the new messages written to {me}, expecting {me} to read or answer them, rather than to other \
             people with {me} only copied or not the one asked? A one-to-one message to {me} is yes.",
        ),
    );
    // the user's rules that could apply to the new items: Jev checks each in the same call
    let hits = rules::candidates(st, &conv.user_id, &conv.connector, conv.contact_id, &new_owned).await?;
    for (i, (r, it)) in hits.iter().enumerate() {
        q.insert(format!("rule_{i}"), rules::question(r, it));
    }
    jev::for_user(&mut q, &owner.name);
    let answers = jev.ask(&state, q).await?;

    let sig = Signals {
        needs_reply: answers.yes("needs_reply").unwrap_or(0.0),
        actionable: answers.yes("actionable").unwrap_or(0.0),
        sensitive: answers.yes("sensitive").unwrap_or(0.0),
        mood_changed: answers.yes("mood_changed").unwrap_or(0.0),
        importance: answers.score_fraction("importance", IMPORTANCE.len()).unwrap_or(0.0),
        kind: answers.choice("kind").map(|(k, _)| k),
        addressed: answers.yes("addressed").unwrap_or(1.0),
        others: others_on(&new_owned, &handles),
        users_call: answers.yes("users_call").unwrap_or(0.0),
        doubts_user: answers.yes("doubts_user").unwrap_or(0.0),
        urgent: answers.yes("urgent").unwrap_or(0.0),
    };
    // items a rule took (done, or waiting for the user) need nothing else; when it took them all,
    // the conversation needs nothing
    let mut taken: Vec<Uuid> = Vec::new();
    for (i, (r, it)) in hits.iter().enumerate() {
        let matched = answers.yes(&format!("rule_{i}")).unwrap_or(0.0);
        match rules::handle(st, r, &conv.connector, it, id, matched).await {
            Ok(true) => taken.push(it.id),
            Ok(false) => {}
            Err(e) => log::warn!("rule {} on {}: {e:#}", r.name, it.id),
        }
    }
    let all_taken = !taken.is_empty() && new_owned.iter().all(|i| taken.contains(&i.id));
    let attention = if all_taken { None } else { attention(&sig, answers.choice("kind").map(|(_, p)| p).unwrap_or(0.0)) };
    let item_ids = new_ids;
    let triage_id: i64 = sqlx::query_scalar(
        "INSERT INTO db_pigeon_triage (conversation_id, item_ids, model, answers, needs_reply, actionable, sensitive, mood_changed, importance, kind)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id",
    )
    .bind(id)
    .bind(&item_ids)
    .bind(&jev.model)
    .bind(&answers.raw)
    .bind(sig.needs_reply as f32)
    .bind(sig.actionable as f32)
    .bind(sig.sensitive as f32)
    .bind(sig.mood_changed as f32)
    .bind(sig.importance as f32)
    .bind(&sig.kind)
    .fetch_one(&st.pool)
    .await?;
    sqlx::query(
        "UPDATE db_pigeon_conversations SET attention = $2, importance = $3, kind = $4,
                handled_at = CASE WHEN $2::text IS NULL THEN handled_at ELSE NULL END, updated_at = NOW()
          WHERE id = $1",
    )
    .bind(id)
    .bind(attention)
    .bind(sig.importance as f32)
    .bind(&sig.kind)
    .execute(&st.pool)
    .await?;
    log::info!(
        "triage {id}: attention {:?}, rules took {}/{}, reply {:.2}, to them {:.2}, others {}, action {:.2}, their call {:.2}, doubts them {:.2}, urgent {:.2}, importance {:.2}, {:?}",
        attention,
        taken.len(),
        new_owned.len(),
        sig.needs_reply,
        sig.addressed,
        sig.others.len(),
        sig.actionable,
        sig.users_call,
        sig.doubts_user,
        sig.urgent,
        sig.importance,
        sig.kind
    );

    let needs = matches!(attention, Some("reply" | "action")) && crate::apps::pigeon::ai::llm::available(&st.pool).await;
    if !needs {
        sqlx::query("UPDATE db_pigeon_conversations SET triaged_at = $2 WHERE id = $1").bind(id).bind(started).execute(&st.pool).await?;
        return Ok("nothing");
    }
    crate::apps::pigeon::events::working(&st.pool, id, "deciding", None, None).await;
    // a new round: what was proposed, asked or told the user before these messages is stale
    if let Err(e) = cards::supersede(st, id).await {
        log::warn!("triage {id}: superseding: {e:#}");
    }
    // the round's start, in the database's clock (what it proposes is stamped by it)
    let round: chrono::DateTime<chrono::Utc> = sqlx::query_scalar("SELECT NOW()").fetch_one(&st.pool).await?;
    // the responder: the reply to them, unless Jev's gate keeps it for the user
    let held = if attention == Some("reply") { gate(&sig) } else { None };
    // the user is writing there: Pigeon doesn't answer, and comes back when they stop (below)
    let paused = actions::quiet_until(st, id).await?;
    let mut outcomes = Vec::new();
    if attention == Some("reply") && held.is_none() && paused.is_none() {
        // an auto reply goes out paced like a person's (`pace`)
        outcomes.extend(agent::respond(st, id, triage_id, &sig).await?);
    }
    // the intaker: tasks and events, and what to ask the user; not needed when the reply took
    // care of it and there's nothing to do or remember
    let replied = outcomes.first().map(|o| o.status.clone());
    if replied.as_deref() == Some("cancelled") {
        // the auto reply was about to go out when they wrote again (the next round answers all
        // of it, already queued) or the user wrote there (answered: seen)
        if outcomes[0].detail.as_deref() != Some("they wrote again") {
            sqlx::query("UPDATE db_pigeon_conversations SET triaged_at = $2 WHERE id = $1").bind(id).bind(started).execute(&st.pool).await?;
        }
        log::info!("triage {id}: the auto reply stopped, {}", outcomes[0].detail.as_deref().unwrap_or_default());
        return Ok("stopped");
    }
    let answered = matches!(replied.as_deref(), Some("done" | "pending"));
    // with their replies off the user answers them: the intaker only for something to do
    let replies_off = policy::resolve(&st.pool, &conv.user_id, crate::apps::pigeon::connectors::Kind::Reply, conv.contact_id, Some(id)).await? == policy::Policy::Off;
    let intake = if paused.is_some() || replies_off {
        sig.actionable >= ACTION_AT
    } else {
        !answered || attention == Some("action") || sig.actionable >= ACTION_AT
    };
    if intake {
        outcomes.extend(agent::intake(st, id, triage_id, &sig, held, replied.as_deref()).await?);
    }
    if let Some(until) = paused {
        // not triaged yet: once the user stopped writing, the round runs again on what they left
        // unanswered (nothing, if they answered it)
        sqlx::query("UPDATE db_pigeon_conversations SET triage_due_at = $2 WHERE id = $1")
            .bind(id)
            .bind(until + chrono::Duration::seconds(5))
            .execute(&st.pool)
            .await?;
        log::info!("triage {id}: the user is writing there, back at {until}");
        return Ok("paused");
    }
    // triaged: what came in before `started` counts as seen from here (cut off before this line,
    // the triage runs again: `run_due`'s lease)
    sqlx::query("UPDATE db_pigeon_conversations SET triaged_at = $2 WHERE id = $1").bind(id).bind(started).execute(&st.pool).await?;
    for o in &outcomes {
        log::info!("triage {id}: proposed → {} {:?}", o.status, o.id);
    }
    // what waits for the user, what was asked, or that it needs them: the cards, pushed
    // (unless they're writing there)
    let nothing = !outcomes.iter().any(|o| matches!(o.status.as_str(), "pending" | "done" | "asked"));
    // with their replies off the user answers them: no "needs you" about it, only what Pigeon
    // proposes or asks
    let note = match (held, nothing, replies_off) {
        (_, _, true) => None,
        (Some(why), _, _) => Some(format!("not answered: {why}")),
        (None, true, _) => Some(if attention == Some("reply") { "needs your answer".to_string() } else { "needs you".to_string() }),
        _ => None,
    };
    // urgent: a card always, and it rings whatever their alert switch (`alerts`)
    let note = if attention.is_some() && sig.urgent >= URGENT_AT {
        Some(match note {
            Some(n) => format!("{} · {n}", cards::URGENT),
            None => cards::URGENT.to_string(),
        })
    } else {
        note
    };
    if !actions::user_writing(st, id).await? {
        if let Err(e) = cards::round(st, id, round, note.as_deref()).await {
            log::warn!("triage {id}: cards: {e:#}");
        }
    }
    Ok(if outcomes.iter().any(|o| o.status == "done") {
        "replied"
    } else if outcomes.iter().any(|o| matches!(o.status.as_str(), "pending" | "asked")) || note.is_some() {
        "asked"
    } else {
        "nothing"
    })
}

/// Everyone else the new messages went to or copied: not the user, not who sent them.
fn others_on(items: &[conversations::Item], me: &[String]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for it in items {
        let sender = it.sender.as_deref().unwrap_or_default();
        for v in [&it.to_addrs, &it.cc_addrs] {
            for a in v.as_array().into_iter().flatten().filter_map(|a| a.as_str()) {
                let mine = me.iter().any(|m| m.eq_ignore_ascii_case(a));
                if !mine && !a.eq_ignore_ascii_case(sender) && !out.iter().any(|o| o.eq_ignore_ascii_case(a)) {
                    out.push(a.to_string());
                }
            }
        }
    }
    out
}

/// What the conversation needs from the user, from Jev's answers.
pub fn attention(sig: &Signals, kind_p: f64) -> Option<&'static str> {
    if sig.kind.as_deref().is_some_and(|k| NOISE.contains(&k)) && kind_p >= NOISE_AT {
        return None;
    }
    // written to someone else: theirs to answer
    if sig.needs_reply >= REPLY_AT && sig.addressed >= ADDRESSED_AT {
        Some("reply")
    } else if sig.actionable >= if sig.importance < LOW_IMPORTANCE { SURE_ACTION_AT } else { ACTION_AT } {
        Some("action")
    } else if sig.importance >= FYI_AT {
        Some("fyi")
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn attention_from_the_signals() {
        let s = |r, a, i, k: &str| Signals { needs_reply: r, actionable: a, importance: i, kind: Some(k.into()), addressed: 0.9, ..Default::default() };
        assert_eq!(attention(&s(0.94, 0.2, 0.8, "money"), 0.6), Some("reply"));
        assert_eq!(attention(&s(0.3, 0.7, 0.2, "update"), 0.6), Some("action"));
        assert_eq!(attention(&s(0.3, 0.2, 0.6, "update"), 0.6), Some("fyi"));
        assert_eq!(attention(&s(0.3, 0.2, 0.2, "social"), 0.6), None);
        assert_eq!(attention(&s(0.9, 0.9, 0.9, "newsletter"), 0.8), None, "sure noise needs nothing");
        assert_eq!(attention(&s(0.9, 0.2, 0.9, "newsletter"), 0.4), Some("reply"), "unsure noise is still looked at");
        assert_eq!(attention(&s(0.1, 0.68, 0.07, "request"), 0.6), None, "a low-importance maybe-task is nothing");
        assert_eq!(attention(&s(0.1, 0.9, 0.07, "request"), 0.6), Some("action"), "a sure one still is");
        let copied = Signals { addressed: 0.2, ..s(0.9, 0.2, 0.6, "question") };
        assert_eq!(attention(&copied, 0.6), Some("fyi"), "a question to someone else is only worth knowing");
    }

    #[test]
    fn the_gate_keeps_the_users_answers() {
        assert_eq!(gate(&Signals::default()), None, "small talk is Pigeon's to answer");
        assert!(gate(&Signals { users_call: 0.9, ..Default::default() }).is_some(), "a date or a yes is theirs");
        let doubt = gate(&Signals { doubts_user: 0.9, users_call: 0.9, ..Default::default() });
        assert!(doubt.is_some_and(|w| w.contains("really you")), "being asked if it's them comes first");
    }
}

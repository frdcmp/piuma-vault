//! Cards: what waits for the user, shown in the person's chat in the Inbox, read straight from
//! what's open (nothing is kept twice, so a card goes the moment its matter is settled, wherever
//! it was settled):
//!
//!   - ❓ question: what only they can answer (whether to meet, a date, "is it really you?"), its
//!     answers as buttons, or their own words
//!   - ✍ draft: a reply waiting for their Send (replies on ask, or one Piuma drafted); its words
//!     can be changed before sending
//!   - 💡 suggestion: something to capture elsewhere (a task, an event): Add or Drop
//!   - 📋 run: one of their rules waiting for a yes
//!   - ✋ needs: Pigeon kept the reply and asks nothing (`needs_note`): Handled, or say what to do
//!   - 🕊 confirm: a big change asked of Piuma (replies to auto, a merge), waiting for a tap
//!
//! When a round leaves cards, the phone hears of it (the vault's push): the first card rings or
//! not by the person's alert switch (alerts), the rest are silent. News (`db_pigeon_news`) is
//! what Pigeon did or found, nothing to decide: in the person's chat, or General.

use serde::Serialize;
use serde_json::{json, Value as Json};
use uuid::Uuid;

use crate::apps::notifications::{notify, Channels, NewNotification};
use crate::apps::pigeon::state::{AppState, State};
use crate::apps::pigeon::{actions, agent, alerts, conversations, events, rules, slugs};

/// The agent's tool to ask the user.
pub const ASK_TOOL: &str = "pigeon_ask_user";
/// Answer buttons on a question, at most.
const MAX_OPTIONS: usize = 4;
/// A round's note when Jev found it urgent: its first card rings whatever the alert switch.
pub const URGENT: &str = "🚨 urgent";
/// Questions nobody answers expire after this many days.
const QUESTION_DAYS: i32 = 7;

#[derive(Debug, Clone, Serialize)]
pub struct Button {
    pub label: String,
    /// what pressing it sends back (`POST …/cards/{kind}/{id}` with `{button}`)
    pub value: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Card {
    /// question · draft · suggestion · run · needs · confirm
    pub kind: &'static str,
    pub id: Uuid,
    pub text: String,
    /// a draft's words, to change before Send
    pub draft: Option<String>,
    /// they may answer in their own words (a question, a needs card)
    pub free_text: bool,
    pub buttons: Vec<Button>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn button(label: &str, value: &str) -> Button {
    Button { label: label.into(), value: value.into() }
}

/// A date or time at a glance: "7 Nov 13:00", "7 Nov".
fn short_when(v: &str) -> String {
    let v = v.trim();
    if let Ok(t) = chrono::DateTime::parse_from_rfc3339(v) {
        return t.format("%-d %b %H:%M").to_string();
    }
    if let Ok(d) = chrono::NaiveDate::parse_from_str(v.get(..10).unwrap_or(v), "%Y-%m-%d") {
        let rest = v.get(10..).unwrap_or_default().trim_start_matches(['T', ' ']);
        return match rest.get(..5).filter(|t| t.contains(':')) {
            Some(t) => format!("{} {t}", d.format("%-d %b")),
            None => d.format("%-d %b").to_string(),
        };
    }
    v.to_string()
}

/// An action's arguments as the user reads them, in a line.
pub fn describe(row: &actions::ActionRow) -> String {
    let a = &row.args;
    let s = |k: &str| a[k].as_str().unwrap_or_default().to_string();
    match (row.kind.as_str(), row.action.as_str()) {
        ("reply", _) => format!("«{}»", s("text")),
        (_, "create_task") => {
            let due = a["due"].as_str().map(|d| format!(" · {}", short_when(d))).unwrap_or_default();
            format!("📌 {}{due}", s("title"))
        }
        (_, "create_event") => format!("📅 {} · {}", s("title"), short_when(&s("start"))),
        (_, act) if tidy_label(act).is_some() => tidy_label(act).unwrap_or_default().to_string(),
        // anything else: its name in words, and what it's given when it's given something
        (_, act) => {
            let what = act.replace('_', " ");
            match a.as_object().filter(|o| !o.is_empty()) {
                Some(_) => format!("{what}: {}", conversations::clip(&a.to_string(), 200)),
                None => what,
            }
        }
    }
}

/// What can be done to an email in place, and its button.
const TIDY: [(&str, &str); 3] = [("archive", "📥 Archive"), ("mark_read", "👁 Mark read"), ("trash", "🗑 Delete")];

fn tidy_label(action: &str) -> Option<&'static str> {
    TIDY.iter().find(|(a, _)| *a == action).map(|(_, l)| *l)
}

/// Archiving, reading or deleting an email: one card for all of them on a conversation.
pub fn is_tidy(row: &actions::ActionRow) -> bool {
    row.kind != "reply" && row.connector == "gmail" && tidy_label(&row.action).is_some()
}

/// The conversation's tidy-ups as one card: what Pigeon suggests, and each choice as a button
/// (`a:archive`, …; "y" takes the first suggestion).
fn tidy_card(rows: &[&actions::ActionRow]) -> Card {
    let suggested: Vec<String> =
        rows.iter().filter_map(|r| tidy_label(&r.action)).map(|l| l.split_once(' ').map_or(l, |(_, w)| w).to_lowercase()).collect();
    let mut buttons: Vec<Button> = TIDY.iter().map(|(a, l)| button(l, &format!("a:{a}"))).collect();
    buttons.push(button("Keep it", "n"));
    Card {
        kind: "suggestion",
        id: rows[0].id,
        text: format!("🧹 Tidy up this email? Pigeon suggests: {}", suggested.join(", ")),
        draft: None,
        free_text: false,
        buttons,
        created_at: rows[0].created_at,
    }
}

/// A tidy-up card pressed: the choice runs (the suggestion that was it, else the card's own
/// turned into it), every other tidy-up on the conversation is dropped.
async fn press_tidy(st: &AppState, user: &str, row: actions::ActionRow, button: &str, by: &str) -> anyhow::Result<String> {
    let choice = match button {
        "n" => None,
        "y" => Some(row.action.clone()),
        b => Some(b.strip_prefix("a:").filter(|a| tidy_label(a).is_some()).ok_or_else(|| anyhow::anyhow!("not a choice: {b}"))?.to_string()),
    };
    let siblings: Vec<actions::ActionRow> =
        actions::list(st, user, Some("pending"), row.conversation_id, 50).await?.into_iter().filter(is_tidy).collect();
    let pick = choice.as_ref().map(|c| siblings.iter().find(|s| &s.action == c).map(|s| s.id).unwrap_or(row.id));
    if let (Some(id), Some(c)) = (pick, &choice) {
        if id == row.id && &row.action != c {
            sqlx::query("UPDATE db_pigeon_actions SET action = $2 WHERE id = $1 AND status = 'pending'").bind(id).bind(c).execute(&st.pool).await?;
        }
    }
    for s in siblings.iter().filter(|s| Some(s.id) != pick) {
        actions::drop(st, s.id, by, Some("another choice on the card")).await?;
    }
    let outcome = match pick {
        Some(id) => {
            let done = actions::approve(st, id, None, by).await?;
            if done.status == "done" {
                news(st, user, done.conversation_id, &format!("✅ {}", describe(&done)), None, false).await;
            }
            outcome_of(&done)
        }
        None => "🗑 Kept as it is".to_string(),
    };
    match row.conversation_id {
        Some(c) => events::conversation(&st.pool, c).await,
        None => events::publish(&st.pool, user, "news", None).await,
    }
    Ok(outcome)
}

/// An action as a card: ✍ a reply to send, 💡 something to add.
fn action_card(row: &actions::ActionRow) -> Card {
    if row.kind == "reply" {
        return Card {
            kind: "draft",
            id: row.id,
            text: format!("✍ {}", describe(row)),
            draft: row.args["text"].as_str().map(str::to_string),
            free_text: false,
            buttons: vec![button("✅ Send", "y"), button("🗑 Drop", "n")],
            created_at: row.created_at,
        };
    }
    let what = describe(row);
    let (label, what) = match row.action.as_str() {
        "create_task" => ("Add task", what.trim_start_matches(['📌', ' ']).to_string()),
        "create_event" => ("Add event", what.trim_start_matches(['📅', ' ']).to_string()),
        _ => ("Do it", what),
    };
    Card {
        kind: "suggestion",
        id: row.id,
        text: format!("💡 {label}: {what}"),
        draft: None,
        free_text: false,
        buttons: vec![button("✅ Add", "y"), button("🗑 Drop", "n")],
        created_at: row.created_at,
    }
}

/// What waits for the user in a conversation (None: General's, the confirmations not about one).
pub async fn list(st: &State, user: &str, conversation: Option<Uuid>) -> anyhow::Result<Vec<Card>> {
    let mut out = Vec::new();
    if let Some(conversation) = conversation {
        let questions: Vec<(Uuid, String, Json, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
            "SELECT id, question, options, created_at FROM db_pigeon_questions WHERE conversation_id = $1 AND status = 'open' ORDER BY created_at",
        )
        .bind(conversation)
        .fetch_all(&st.pool)
        .await?;
        for (id, question, options, created_at) in questions {
            let mut buttons: Vec<Button> =
                options.as_array().into_iter().flatten().filter_map(|o| o.as_str()).enumerate().map(|(i, o)| button(o, &i.to_string())).collect();
            buttons.push(button("🗑 Drop", "x"));
            out.push(Card { kind: "question", id, text: format!("❓ {question}"), draft: None, free_text: true, buttons, created_at });
        }
        let mut rows = actions::list(st, user, Some("pending"), Some(conversation), 20).await?;
        // an auto one is on its way (Pigeon is typing it): nothing to approve
        rows.retain(|r| r.policy != "auto");
        rows.sort_by_key(|a| (a.kind != "reply", a.created_at));
        let (tidy, rest): (Vec<_>, Vec<_>) = rows.iter().partition(|r| is_tidy(r));
        out.extend(rest.into_iter().map(action_card));
        if !tidy.is_empty() {
            out.push(tidy_card(&tidy));
        }
        let runs: Vec<(Uuid, i32, Json, Option<String>, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
            "SELECT id, rule_id, steps, reason, created_at FROM db_pigeon_rule_runs WHERE conversation_id = $1 AND status = 'pending' ORDER BY created_at",
        )
        .bind(conversation)
        .fetch_all(&st.pool)
        .await?;
        for (id, rule_id, steps, reason, created_at) in runs {
            let rule = rules::get(st, rule_id).await?.map(|r| r.name).unwrap_or_default();
            let mut text = format!("📋 rule «{rule}»");
            for step in steps.as_array().into_iter().flatten() {
                text.push_str(&format!("\n• {}.{}", step["connector"].as_str().unwrap_or("?"), step["action"].as_str().unwrap_or("?")));
            }
            if let Some(r) = reason {
                text.push_str(&format!("\nwaits: {r}"));
            }
            out.push(Card { kind: "run", id, text, draft: None, free_text: false, buttons: vec![button("✅ Run it", "y"), button("🗑 Drop", "n")], created_at });
        }
        let needs: Option<(Option<String>, chrono::DateTime<chrono::Utc>)> =
            sqlx::query_as("SELECT needs_note, COALESCE(triaged_at, updated_at) FROM db_pigeon_conversations WHERE id = $1 AND needs_note IS NOT NULL")
                .bind(conversation)
                .fetch_optional(&st.pool)
                .await?;
        if let Some((Some(note), at)) = needs {
            let text = if note.starts_with(URGENT) { note } else { format!("✋ {note}") };
            out.push(Card { kind: "needs", id: conversation, text, draft: None, free_text: true, buttons: vec![button("✓ Handled", "y")], created_at: at });
        }
    }
    if conversation.is_none() {
        // drafts not on a conversation (a new email): General's
        let rows: Vec<actions::ActionRow> = actions::list(st, user, Some("pending"), None, 50).await?.into_iter().filter(|a| a.conversation_id.is_none()).collect();
        out.extend(rows.iter().map(action_card));
    }
    let confirms: Vec<(Uuid, String, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT id, summary, created_at FROM db_pigeon_confirmations
          WHERE user_id = $1 AND status = 'pending' AND conversation_id IS NOT DISTINCT FROM $2 ORDER BY created_at",
    )
    .bind(user)
    .bind(conversation)
    .fetch_all(&st.pool)
    .await?;
    for (id, summary, created_at) in confirms {
        out.push(Card {
            kind: "confirm",
            id,
            text: format!("🕊 {summary}?"),
            draft: None,
            free_text: false,
            buttons: vec![button("✅ Yes, do it", "y"), button("✖ Cancel", "n")],
            created_at,
        });
    }
    Ok(out)
}

/// The push for a card or news: who it's about as the title, the text as the body; ringing or
/// silent (the app's two notification channels), with the card's buttons.
/// The phone's Android channels (the app makes them; the user tunes each in Android's settings):
/// a person's messages, a group's, Pigeon's cards (it needs them), its news, and the quiet ones.
const CH_MESSAGES: &str = "pigeon-messages";
const CH_GROUPS: &str = "pigeon-groups";
const CH_CARDS: &str = "pigeon-ring";
const CH_NEWS: &str = "pigeon-news";
const CH_QUIET: &str = "pigeon-silent";

/// A card, or news (no card), on the phone: rings on its channel, or arrives quietly.
async fn push(st: &State, user: &str, conversation: Option<Uuid>, card: Option<&Card>, text: &str, ring: bool) {
    let channel = match (ring, card) {
        (false, _) => CH_QUIET,
        (true, Some(_)) => CH_CARDS,
        (true, None) => CH_NEWS,
    };
    let category = card.map(|c| format!("pigeon-{}", c.kind));
    let card = card.map(|c| json!({ "kind": c.kind, "id": c.id, "buttons": c.buttons, "free_text": c.free_text }));
    send(st, user, conversation, json!({ "card": card }), text, ring, channel, category).await;
}

/// The push itself: titled by who the conversation is with, opening it; `extra` joins the
/// metadata (with `conversation_id` and `ring`).
#[allow(clippy::too_many_arguments)]
async fn send(st: &State, user: &str, conversation: Option<Uuid>, extra: Json, text: &str, ring: bool, channel: &str, category: Option<String>) {
    let title = match conversation {
        Some(c) => heading(st, c).await.unwrap_or_else(|_| "Pigeon".into()),
        None => "Pigeon".into(),
    };
    let url = match conversation {
        Some(c) => format!("/inbox/{c}"),
        None => "/inbox".into(),
    };
    let mut metadata = json!({ "conversation_id": conversation, "ring": ring });
    if let (Some(m), Json::Object(extra)) = (metadata.as_object_mut(), extra) {
        m.extend(extra);
    }
    let mut n = NewNotification::new(user, "pigeon", title).body(text).action_url(url).metadata(metadata);
    // to the Pigeon app (the Piuma app has no Inbox)
    n = n.phone_app(crate::apps::notifications::expo::PIGEON).push_channel(channel).silent(!ring);
    if let Some(c) = category {
        n = n.push_category(c);
    }
    // the Inbox is where cards and news live: no bell row of their own
    notify(&st.pool, None, n, Channels { inbox: false, web_push: true, expo: true }).await;
}

/// "@marco · WhatsApp": who a conversation is with, as a push's title.
async fn heading(st: &State, conversation: Uuid) -> anyhow::Result<String> {
    let conv = conversations::get(&st.pool, conversation).await?.ok_or_else(|| anyhow::anyhow!("no conversation"))?;
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let who = conversations::who(contact.as_ref(), &conv);
    let tag = slugs::tag(st, conv.contact_id, &who).await;
    let channel = crate::apps::pigeon::connectors::find(st, &conv.connector).map(|c| c.title()).unwrap_or("?");
    Ok(format!("{tag} · {channel}"))
}

/// News, nothing to decide: in the conversation's chat (or General), and on the phone.
pub async fn news(st: &State, user: &str, conversation: Option<Uuid>, text: &str, url: Option<&str>, ring: bool) {
    let r = sqlx::query("INSERT INTO db_pigeon_news (user_id, conversation_id, text, url) VALUES ($1, $2, $3, $4)")
        .bind(user)
        .bind(conversation)
        .bind(text)
        .bind(url)
        .execute(&st.pool)
        .await;
    if let Err(e) = r {
        log::warn!("pigeon news: {e:#}");
        return;
    }
    events::publish(&st.pool, user, "news", conversation).await;
    let body = match url {
        Some(u) => format!("{text}\n{u}"),
        None => text.to_string(),
    };
    push(st, user, conversation, None, &body, ring).await;
}

/// A message from someone came in: on the phone by their alert switch (all rings; smart and
/// quiet arrive silently; off: nothing), with Reply and Mark as read. In a group, who wrote it
/// heads the text.
pub async fn message_in(st: &State, user: &str, item: Uuid) -> anyhow::Result<()> {
    let row: Option<(Uuid, Option<String>, Option<String>, String)> =
        sqlx::query_as("SELECT conversation_id, sender_name, sender, body FROM db_pigeon_items WHERE id = $1").bind(item).fetch_optional(&st.pool).await?;
    let Some((conversation, name, sender, body)) = row else { return Ok(()) };
    let ring = match alerts::for_message(alerts::of_conversation(&st.pool, conversation).await?) {
        alerts::Delivery::Skip => return Ok(()),
        alerts::Delivery::Silent => false,
        alerts::Delivery::Ring => true,
    };
    let conv = conversations::get(&st.pool, conversation).await?.ok_or_else(|| anyhow::anyhow!("no conversation"))?;
    let text = conversations::clip(&body, 300);
    // a group (no contact): who wrote it
    let group = conv.contact_id.is_none();
    let text = match (group, name.or(sender)) {
        (true, Some(who)) => format!("{who}: {text}"),
        _ => text,
    };
    let channel = match (ring, group) {
        (false, _) => CH_QUIET,
        (true, true) => CH_GROUPS,
        (true, false) => CH_MESSAGES,
    };
    send(st, user, Some(conversation), json!({ "message": item }), &text, ring, channel, Some("pigeon-message".into())).await;
    Ok(())
}

/// Something about Pigeon itself (its health, the morning's summary), in General, ringing.
pub async fn alert(st: &State, user: &str, text: &str) {
    news(st, user, None, text, None, true).await;
}

/// New messages came in on a conversation: what Pigeon proposed or asked before them, still
/// waiting, is stale.
pub async fn supersede(st: &State, conversation: Uuid) -> anyhow::Result<()> {
    actions::supersede_proposals(st, conversation).await?;
    sqlx::query("UPDATE db_pigeon_questions SET status = 'expired' WHERE conversation_id = $1 AND status = 'open'").bind(conversation).execute(&st.pool).await?;
    sqlx::query("UPDATE db_pigeon_conversations SET needs_note = NULL WHERE id = $1").bind(conversation).execute(&st.pool).await?;
    events::conversation(&st.pool, conversation).await;
    Ok(())
}

/// A question the user won't answer: closed. None when the id isn't an open question.
pub async fn drop_question(st: &State, id: Uuid) -> anyhow::Result<Option<Json>> {
    let q: Option<(Uuid, String)> =
        sqlx::query_as("UPDATE db_pigeon_questions SET status = 'expired' WHERE id = $1 AND status = 'open' RETURNING conversation_id, question")
            .bind(id)
            .fetch_optional(&st.pool)
            .await?;
    let Some((conversation, question)) = q else { return Ok(None) };
    events::conversation(&st.pool, conversation).await;
    Ok(Some(json!({ "question": id, "asked": question, "status": "dropped" })))
}

/// Questions nobody answered in a week expire.
pub async fn sweep(st: &State) -> anyhow::Result<u64> {
    Ok(sqlx::query("UPDATE db_pigeon_questions SET status = 'expired' WHERE status = 'open' AND created_at < NOW() - make_interval(days => $1)")
        .bind(QUESTION_DAYS)
        .execute(&st.pool)
        .await?
        .rows_affected())
}

/// The intaker asks the user: the question kept; its card comes with the round's (`round`).
pub async fn ask(st: &State, conversation: Uuid, question: &str, options: &[String]) -> anyhow::Result<Uuid> {
    let options: Vec<String> = options.iter().map(|o| o.trim().to_string()).filter(|o| !o.is_empty()).take(MAX_OPTIONS).collect();
    Ok(sqlx::query_scalar("INSERT INTO db_pigeon_questions (conversation_id, question, options) VALUES ($1, $2, $3) RETURNING id")
        .bind(conversation)
        .bind(question)
        .bind(json!(options))
        .fetch_one(&st.pool)
        .await?)
}

/// What a round left for the user: its cards are already open (questions, drafts,
/// suggestions); when it left none but needs them, `note` says why (the ✋ card). The phone
/// hears of the new ones: the first rings by the person's alert switch (urgent always), the rest
/// are silent. Nothing reaches the phone when their alerts are off, unless it's urgent.
pub async fn round(st: &State, conversation: Uuid, since: chrono::DateTime<chrono::Utc>, note: Option<&str>) -> anyhow::Result<()> {
    let conv = conversations::get(&st.pool, conversation).await?.ok_or_else(|| anyhow::anyhow!("no conversation {conversation}"))?;
    let user = conv.user_id.clone();
    let urgent = note.is_some_and(|n| n.starts_with(URGENT));
    let fresh: Vec<Card> = list(st, &user, Some(conversation)).await?.into_iter().filter(|c| c.created_at >= since && c.kind != "needs").collect();
    let note = if fresh.is_empty() { note } else { None };
    if let Some(n) = note {
        sqlx::query("UPDATE db_pigeon_conversations SET needs_note = $2 WHERE id = $1").bind(conversation).bind(n).execute(&st.pool).await?;
    }
    events::conversation(&st.pool, conversation).await;
    let mut ring = match alerts::for_brief(alerts::of_conversation(&st.pool, conversation).await?, urgent) {
        alerts::Delivery::Skip => {
            log::info!("pigeon cards on {conversation}: alerts off, kept in the Inbox");
            return Ok(());
        }
        alerts::Delivery::Silent => false,
        alerts::Delivery::Ring => true,
    };
    let mark = if urgent { "🚨 " } else { "" };
    let mut cards = fresh;
    if let Some(n) = note {
        if let Some(c) = list(st, &user, Some(conversation)).await?.into_iter().find(|c| c.kind == "needs") {
            cards.push(c);
        } else {
            log::debug!("pigeon cards on {conversation}: note {n} not found");
        }
    }
    for c in &cards {
        let text = if c.text.starts_with(URGENT) { c.text.clone() } else { format!("{mark}{}", c.text) };
        push(st, &user, Some(conversation), Some(c), &text, ring).await;
        ring = false;
    }
    Ok(())
}

/// A rule run waits for the user (its rule is on ask, or Jev wasn't sure): its card, pushed by
/// the conversation's alert switch.
pub async fn run_waiting(st: &State, user: &str, conversation: Uuid, run: Uuid) -> anyhow::Result<()> {
    events::conversation(&st.pool, conversation).await;
    let ring = match alerts::for_brief(alerts::of_conversation(&st.pool, conversation).await?, false) {
        alerts::Delivery::Skip => return Ok(()),
        alerts::Delivery::Silent => false,
        alerts::Delivery::Ring => true,
    };
    if let Some(c) = list(st, user, Some(conversation)).await?.into_iter().find(|c| c.kind == "run" && c.id == run) {
        push(st, user, Some(conversation), Some(&c), &c.text, ring).await;
    }
    Ok(())
}

/// The user answered a question: Pigeon goes back to the conversation with it.
pub async fn answer(st: &AppState, question: Uuid, answer: &str, by: &str) -> anyhow::Result<String> {
    let row: Option<(Uuid, String)> = sqlx::query_as(
        "UPDATE db_pigeon_questions SET status = 'answered', answer = $2, answered_by = $3, answered_at = NOW()
          WHERE id = $1 AND status = 'open' RETURNING conversation_id, question",
    )
    .bind(question)
    .bind(answer)
    .bind(by)
    .fetch_optional(&st.pool)
    .await?;
    let Some((conversation, asked)) = row else { return Ok("That question is answered already.".into()) };
    events::conversation(&st.pool, conversation).await;
    act_on(st, conversation, asked, answer.to_string());
    Ok("Got it: Pigeon is on it.".into())
}

/// Pigeon back on a conversation with what the user said: a reply waiting or something to add
/// comes as its card; what failed, or nothing to do, is told (what went out is in the chat).
fn act_on(st: &AppState, conversation: Uuid, asked: String, answer: String) {
    let st = st.clone();
    tokio::task::spawn_local(async move {
        let Ok(Some(conv)) = conversations::get(&st.pool, conversation).await else { return };
        let user = conv.user_id;
        let outcomes = match agent::after_answer(&st, conversation, &asked, &answer).await {
            Ok(o) => o,
            Err(e) => {
                log::warn!("pigeon answer on {conversation}: {e:#}");
                news(&st, &user, Some(conversation), &format!("⚠ Pigeon couldn't act on your answer: {e:#}"), None, false).await;
                return;
            }
        };
        if outcomes.is_empty() {
            news(&st, &user, Some(conversation), "Pigeon found nothing to do with your answer.", None, false).await;
        }
        for o in outcomes {
            let Some(id) = o.id else { continue };
            let Ok(Some(row)) = actions::get(&st, id).await else { continue };
            match o.status.as_str() {
                "pending" => {
                    let card = action_card(&row);
                    push(&st, &user, Some(conversation), Some(&card), &card.text, false).await;
                }
                "done" if row.kind != "reply" => news(&st, &user, Some(conversation), &format!("✅ {}", describe(&row)), url_of(&row).as_deref(), false).await,
                "failed" => news(&st, &user, Some(conversation), &format!("⚠ {}: {}", row.error.as_deref().unwrap_or("?"), describe(&row)), None, false).await,
                _ => {}
            }
        }
        events::conversation(&st.pool, conversation).await;
    });
}

/// A card's button pressed, or its words sent (a question answered in their own words, a
/// draft's new text, what to do about a conversation): what came of it, in a few words.
pub async fn press(st: &AppState, user: &str, kind: &str, id: Uuid, button: &str, text: Option<&str>) -> anyhow::Result<String> {
    let by = "user (Inbox)";
    let text = text.map(str::trim).filter(|t| !t.is_empty());
    match kind {
        "draft" | "suggestion" => {
            let row = actions::get(st, id).await?.filter(|r| r.user_id == user).ok_or_else(|| anyhow::anyhow!("that card is gone"))?;
            if is_tidy(&row) && row.status == "pending" {
                return press_tidy(st, user, row, button, by).await;
            }
            let row = if button == "y" {
                let edits = match (text, row.kind.as_str()) {
                    (Some(t), "reply") => Some(json!({ "text": t })),
                    _ => None,
                };
                actions::approve(st, id, edits.as_ref(), by).await?
            } else {
                actions::drop(st, id, by, Some("dropped in the Inbox")).await?
            };
            if row.status == "done" && row.kind != "reply" {
                news(st, user, row.conversation_id, &format!("✅ {}", describe(&row)), url_of(&row).as_deref(), false).await;
            }
            match row.conversation_id {
                Some(c) => events::conversation(&st.pool, c).await,
                None => events::publish(&st.pool, user, "news", None).await,
            }
            Ok(outcome_of(&row))
        }
        "run" => {
            if rules::run_owner(st, id).await?.as_deref() != Some(user) {
                anyhow::bail!("that card is gone");
            }
            let run = rules::get_run(st, id).await?.ok_or_else(|| anyhow::anyhow!("that card is gone"))?;
            let run = if button == "y" { rules::execute(st, run.id, by).await? } else { rules::drop(st, run.id, by, Some("dropped in the Inbox")).await? };
            events::conversation(&st.pool, run.conversation_id).await;
            Ok(match run.status.as_str() {
                "done" => "✅ Done".to_string(),
                "dropped" => "🗑 Dropped".to_string(),
                s => format!("⚠ {s}: {}", run.error.as_deref().unwrap_or_default()),
            })
        }
        "question" => {
            let theirs: bool = sqlx::query_scalar(
                "SELECT EXISTS (SELECT 1 FROM db_pigeon_questions q JOIN db_pigeon_conversations c ON c.id = q.conversation_id WHERE q.id = $1 AND c.user_id = $2)",
            )
            .bind(id)
            .bind(user)
            .fetch_one(&st.pool)
            .await?;
            if !theirs {
                anyhow::bail!("that card is gone");
            }
            if button == "x" {
                drop_question(st, id).await?;
                return Ok("🗑 Dropped".into());
            }
            let pick = match text {
                Some(t) => t.to_string(),
                None => {
                    let options: Option<Json> = sqlx::query_scalar("SELECT options FROM db_pigeon_questions WHERE id = $1").bind(id).fetch_optional(&st.pool).await?;
                    button
                        .parse::<usize>()
                        .ok()
                        .and_then(|i| options.as_ref()?.get(i)?.as_str().map(str::to_string))
                        .ok_or_else(|| anyhow::anyhow!("that answer isn't one of the question's"))?
                }
            };
            answer(st, id, &pick, by).await
        }
        "needs" => {
            sqlx::query("UPDATE db_pigeon_conversations SET attention = NULL, needs_note = NULL, handled_at = NOW() WHERE id = $1 AND user_id = $2")
                .bind(id)
                .bind(user)
                .execute(&st.pool)
                .await?;
            events::conversation(&st.pool, id).await;
            match text {
                Some(t) => {
                    act_on(st, id, "What should Pigeon do about this conversation?".into(), t.to_string());
                    Ok("Got it: Pigeon is on it.".into())
                }
                None => Ok("✓ Handled".into()),
            }
        }
        "confirm" => crate::apps::pigeon::confirm::decide(st, user, id, button == "y").await,
        _ => anyhow::bail!("a card Pigeon doesn't know"),
    }
}

/// What an action made, to open (a vault task, event or note).
pub fn url_of(row: &actions::ActionRow) -> Option<String> {
    row.result.as_ref().and_then(|r| r["url"].as_str()).map(str::to_string)
}

pub fn outcome_of(row: &actions::ActionRow) -> String {
    match row.status.as_str() {
        "done" if row.kind == "reply" => "✅ Sent".into(),
        "done" => "✅ Done".into(),
        "dropped" => "🗑 Dropped".into(),
        s => format!("⚠ {s}: {}", row.error.as_deref().unwrap_or_default()),
    }
}

/// Questions the user hasn't answered, for Piuma.
pub async fn open_questions(st: &State, user: &str) -> anyhow::Result<Vec<Json>> {
    let rows: Vec<(Uuid, Uuid, String, Json, chrono::DateTime<chrono::Utc>)> = sqlx::query_as(
        "SELECT q.id, q.conversation_id, q.question, q.options, q.created_at FROM db_pigeon_questions q
           JOIN db_pigeon_conversations c ON c.id = q.conversation_id
          WHERE c.user_id = $1 AND q.status = 'open' ORDER BY q.created_at DESC LIMIT 50",
    )
    .bind(user)
    .fetch_all(&st.pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(id, conversation_id, question, options, created_at)| {
            json!({ "kind": "question", "id": id, "conversation_id": conversation_id, "question": question, "options": options, "created_at": created_at })
        })
        .collect())
}

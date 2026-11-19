//! What Pigeon tells the people who write, by what they hold (`access`). In triage Jev is asked,
//! with the rest, whether the new messages ask for what a tool gives (`offer`: the user's place,
//! whether they're free, what is in a note of theirs). Then, for each thing asked:
//!
//!   - they hold it: the responder is given what the tool says at their level (a `Use`), and
//!     writes the reply with it. It goes on its own only when everything agrees: the permission
//!     is `auto`, Jev is sure of the question (`SURE_AT`) and of its gate (asked for themselves,
//!     plainly, and nothing else that is the user's to answer), the fact is fresh, and the reply,
//!     read back, says nothing beyond it (`leaks`). Anything less: a draft, the user sends it
//!   - they don't: a 🔑 card to the user (answer this once, allow it from now on, or no); nothing
//!     is told
//!   - they hold it and Pigeon knows nothing to say (no place: the phone's switch is off): nothing
//!     is told, and the user reads why in the chat (`unknown`), with nothing to answer
//!
//! Notes (`shared`) are held one by one: asked for something the user may have written down,
//! Pigeon looks only among the notes the chat holds, Jev says which one answers (or none), and
//! that whole note is what the reply is written from, one note a reply. On its own only when,
//! besides the above, Jev is sure of the note, it isn't cut for its length, and the reply holds
//! no card number (an account number or an IBAN goes: those are given to be paid). A note that
//! answers but that only others hold is the 🔑 card; a note shared with nobody is never looked at.
//!
//! What was used stays on the reply (`args.used`, the record: the tool, the level, the permission
//! and where it came from, how sure Jev was), shown beside the message; "this was wrong" on it
//! sets the grants behind it back to ask. Pigeon never gives itself more: after three drafts
//! sent as written it proposes auto, as a card the user taps.

use std::collections::HashSet;

use chrono::{DateTime, Utc};
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value as Json};
use uuid::Uuid;

use crate::apps::pigeon::access::{self, Book, Holder, NoteEff, Target, What};
use crate::apps::pigeon::actions::{self, ActionRow};
use crate::apps::pigeon::ai::jev::{self, Answers};
use crate::apps::pigeon::confirm::{self, Tap};
use crate::apps::pigeon::conversations::{self, Conversation};
use crate::apps::pigeon::facts;
use crate::apps::pigeon::offer::{self, Permission, Tool};
use crate::apps::pigeon::owner::{self, Owner};
use crate::apps::pigeon::state::{AppState, State};
use crate::apps::pigeon::triage::{Signals, HOLD_AT};
use crate::apps::pigeon::{cards, events, people, shared, tools};
use crate::apps::telemetry::{Event, Severity};
use crate::db::db::DbPool;

/// From here Jev's yes counts: the new messages ask for it.
pub const ASKED_AT: f64 = 0.5;
/// What telling on its own needs: of the question, and of each of the gate's.
pub const SURE_AT: f64 = 0.8;
/// From here the reply, read back, says too much (or promises): it waits for the user.
pub const LEAK_AT: f64 = 0.5;
/// Drafts sent as written through one ask grant before Pigeon proposes auto for it.
const SUGGEST_AFTER: i64 = 3;
/// The calendar a reply may speak of: from now, this many days.
const CALENDAR_DAYS: i32 = 7;
/// What was told, kept on the record, at most.
const MAX_TOLD: usize = 600;
/// The events a calendar answer is written from, at most.
const CALENDAR_EVENTS: i64 = 40;
/// Notes: how many of the chat's Jev picks among (and as many that only others hold).
const NOTE_PICKS: i64 = 3;
/// A note a reply is written from, at most: a longer one is cut, and never told on its own.
const NOTE_MAX: usize = 8000;
/// Of each note, what Jev reads to say which one answers.
const NOTE_PEEK: usize = 3000;

/// One tool used in one reply: what Pigeon was given, by which permission, and how sure Jev was.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Use {
    pub tool: String,
    pub label: String,
    pub level: String,
    pub level_label: String,
    pub has_levels: bool,
    pub permission: String,
    pub grant_id: Option<Uuid>,
    /// where the permission comes from, in words: "their own", "from Friends", "this once"
    pub via: String,
    /// how sure Jev was that they asked for it
    pub jev: f64,
    /// the words Pigeon was given
    pub told: String,
    /// it may go on its own
    pub auto: bool,
    /// the fact's time
    pub at: Option<DateTime<Utc>>,
    pub stale: bool,
    /// the note told from
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub note_id: Option<Uuid>,
    /// the user marked it wrong
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub wrong: bool,
    /// the same fact's finer words: what the reply must not hold (never kept)
    #[serde(skip)]
    pub beyond: Vec<String>,
    /// how the agent is told (never kept)
    #[serde(skip)]
    pub how: String,
    /// of what it was given, the only thing a reply may say (never kept): the calendar is given
    /// whole, to answer "free or busy" from
    #[serde(skip)]
    pub only: Option<String>,
    /// all it was given, where `told` is only its start (never kept): a note
    #[serde(skip)]
    pub whole: Option<String>,
    /// why it waits for the user though they hold it on auto (never kept)
    #[serde(skip)]
    pub waits: Option<String>,
}

/// Something asked that they don't hold.
pub struct Uncovered {
    pub tool: &'static Tool,
    pub jev: f64,
    /// Notes: the note that answers, which others hold (its id, its title)
    pub note: Option<(Uuid, String)>,
}

#[derive(Default)]
pub struct Round {
    pub uses: Vec<Use>,
    pub uncovered: Vec<Uncovered>,
    /// asked and held, with nothing to say (no place from the phone)
    pub unknown: Vec<&'static Tool>,
}

/// Jev's questions in triage: one per tool.
pub fn questions(q: &mut Map<String, Json>) {
    for t in offer::TOOLS.iter().filter(|t| t.live) {
        q.insert(format!("tool_{}", t.name), jev::noul(t.asks));
    }
}

/// What a tool says at a level, now.
struct Said {
    /// the level it could be said at (the one asked, or a lower one the fact has)
    level: usize,
    told: String,
    how: String,
    beyond: Vec<String>,
    only: Option<String>,
    at: Option<DateTime<Utc>>,
    stale: bool,
}

/// The words of a finer level that the coarser one doesn't say.
fn finer(told: &str, more: &[String]) -> Vec<String> {
    let told = told.to_lowercase();
    let mut out: Vec<String> = Vec::new();
    for part in more.iter().flat_map(|m| m.split(',')).map(|p| p.trim().to_lowercase()).filter(|p| p.chars().count() >= 3) {
        if !told.contains(&part) && !out.contains(&part) {
            out.push(part);
        }
    }
    out
}

/// What a tool says at a level; none: Pigeon knows nothing to say (no place yet).
async fn say(st: &State, user: &str, me: &Owner, tool: &Tool, level: usize) -> anyhow::Result<Option<Said>> {
    match tool.name {
        "location" => place(st, user, me, tool, level).await,
        "calendar" => calendar(st, user, me, level).await,
        _ => Ok(None),
    }
}

async fn place(st: &State, user: &str, me: &Owner, tool: &Tool, level: usize) -> anyhow::Result<Option<Said>> {
    // the place as of now: the phone is asked when the one stored is older than two minutes (it
    // writes the fact read below), else an on-demand place is always old and never goes on its own
    facts::spot_now(&st.pool, user).await?;
    let Some(f) = facts::latest(&st.pool, user, tool.name).await? else { return Ok(None) };
    let top = level.min(tool.levels.len().saturating_sub(1));
    let Some((level, told)) = (0..=top).rev().find_map(|i| f.at_level(tool.levels[i].name).map(|w| (i, w))) else { return Ok(None) };
    let more: Vec<String> = tool.levels.iter().skip(level + 1).filter_map(|l| f.at_level(l.name)).collect();
    let how = format!("Where {} is right now (as of {}): {told}. Say it no more precisely than that.", me.name, me.local(f.at).format("%H:%M"));
    Ok(Some(Said { level, beyond: finer(&told, &more), only: None, told, how, at: Some(f.at), stale: f.stale() }))
}

async fn calendar(st: &State, user: &str, me: &Owner, level: usize) -> anyhow::Result<Option<Said>> {
    let rows: Vec<(String, DateTime<Utc>, Option<DateTime<Utc>>, bool)> = sqlx::query_as(
        "SELECT title, starts_at, ends_at, all_day FROM db_calendar_events
          WHERE user_id = $1 AND starts_at < NOW() + make_interval(days => $2)
            AND COALESCE(ends_at, starts_at + CASE WHEN all_day THEN INTERVAL '1 day' ELSE INTERVAL '1 hour' END) > NOW()
          ORDER BY starts_at LIMIT $3",
    )
    .bind(user)
    .bind(CALENDAR_DAYS)
    .bind(CALENDAR_EVENTS)
    .fetch_all(&st.pool)
    .await?;
    // an event's repeats are stored, expanded nowhere: with any, the list may miss what's on
    let repeats: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM db_calendar_events WHERE user_id = $1 AND rrule IS NOT NULL AND rrule <> '')")
        .bind(user)
        .fetch_one(&st.pool)
        .await?;
    let name = &me.name;
    let lines: Vec<String> = rows
        .iter()
        .map(|(title, starts, ends, all_day)| {
            let (s, e) = (me.local(*starts), me.local(ends.unwrap_or(*starts + chrono::Duration::hours(1))));
            let span = match (*all_day, s.date_naive() == e.date_naive()) {
                (true, _) => "all day".to_string(),
                (false, true) => format!("{}–{}", s.format("%H:%M"), e.format("%H:%M")),
                (false, false) => format!("{}–{}", s.format("%H:%M"), e.format("%a %-d %b %H:%M")),
            };
            format!("{} {span}: {}", s.format("%a %-d %b"), if level >= 2 { title.trim() } else { "busy" })
        })
        .collect();
    let told = if lines.is_empty() { format!("nothing on the calendar in the next {CALENDAR_DAYS} days") } else { lines.join("\n") };
    let (may, only) = match level {
        0 => (
            format!("Say only whether {name} is free or busy at the time they ask about: not the times of what's on, nor what it is."),
            Some(format!("whether {name} is free or busy at the time they asked about: not when anything starts or ends, nor what it is")),
        ),
        1 => (format!("You may say when {name} is busy and when free; never what it is."), Some(format!("when {name} is busy and when free: never what anything is"))),
        _ => (format!("You may say what's on at the time they ask about."), None),
    };
    let mut how = format!(
        "{name}'s calendar from now ({} {}, {}), the next {CALENDAR_DAYS} days:\n{told}\n{may} Being free isn't a yes: never accept a meeting, a call or a plan for {name}.",
        me.now().format("%a %-d %b %H:%M"),
        me.tz,
        me.now().format("UTC%:z"),
    );
    if repeats {
        how.push_str(&format!(" What repeats isn't listed: never say {name} is surely free."));
    }
    let beyond = if level >= 2 { Vec::new() } else { rows.iter().map(|r| r.0.trim().to_lowercase()).filter(|t| t.chars().count() >= 4).collect() };
    // cut at the limit, it may miss what's on: like repeats, never on its own
    Ok(Some(Said { level, told, how, beyond, only, at: None, stale: repeats || rows.len() as i64 >= CALENDAR_EVENTS }))
}

fn put(u: &mut Use, tool: &Tool, s: Said) {
    let l = &tool.levels[s.level.min(tool.levels.len() - 1)];
    u.level = l.name.to_string();
    u.level_label = l.label.to_string();
    u.told = conversations::clip(&s.told, MAX_TOLD);
    u.how = s.how;
    u.beyond = s.beyond;
    u.only = s.only;
    u.at = s.at;
    u.stale = s.stale;
}

fn blank(tool: &Tool, permission: String, grant: Option<Uuid>, via: String, p: f64, auto: bool) -> Use {
    Use {
        tool: tool.name.to_string(),
        label: tool.label.to_string(),
        level: String::new(),
        level_label: String::new(),
        has_levels: tool.has_levels(),
        permission,
        grant_id: grant,
        via,
        jev: p,
        told: String::new(),
        auto,
        at: None,
        stale: false,
        note_id: None,
        wrong: false,
        beyond: Vec::new(),
        how: String::new(),
        only: None,
        whole: None,
        waits: None,
    }
}

/// A use filled from a note: all of it is what the reply is written from. False: it waits for
/// the user whatever the grant says (it is cut for its length).
fn of_note(u: &mut Use, tool: &Tool, n: &shared::Note, me: &Owner) -> bool {
    let long = n.content.chars().count() > NOTE_MAX;
    let text: String = n.content.chars().take(NOTE_MAX).collect();
    let (name, title) = (&me.name, conversations::clip(&n.title, 80));
    u.label = format!("{} · {title}", tool.label);
    u.level = tool.levels[0].name.to_string();
    u.level_label = tool.levels[0].label.to_string();
    u.note_id = Some(n.id);
    u.told = conversations::clip(&text, MAX_TOLD);
    u.how = format!(
        "{name}'s note «{title}»{}:\n«\n{}\n»\nAnswer what they ask with what this note says, and only that: nothing from it they didn't ask for, nothing that isn't in it, and no promise for {name}. If it doesn't answer them, don't guess: say {name} will get back to them.",
        if long { " (its start: the rest is cut)" } else { "" },
        text.trim(),
    );
    u.whole = Some(text);
    !long
}

/// Where a note's leave comes from, in words: "from Family, in /shared/trip".
fn via_of(e: &NoteEff) -> String {
    match &e.target {
        Target::Folder(f) => format!("{}, in {f}", e.from.words()),
        Target::Note(_) => e.from.words(),
    }
}

/// Which of these notes holds what was asked, and how sure Jev is; none: no note answers, or
/// Jev can't be asked.
async fn pick(st: &State, conv: &Conversation, me: &Owner, asked: &str, notes: &[shared::Note]) -> Option<(usize, f64)> {
    let jev = st.jev.as_ref()?;
    let keys: Vec<String> = (0..notes.len()).map(|i| format!("n{i}")).collect();
    let peeks: Map<String, Json> =
        keys.iter().zip(notes).map(|(k, n)| (k.clone(), json!({ "title": n.title, "text": n.content.chars().take(NOTE_PEEK).collect::<String>() }))).collect();
    let state = json!({ "channel": conv.connector, "the_user": me.name, "new_messages": conversations::clip(asked, 3000), "notes": peeks });
    let mut options: Vec<(&str, Option<&str>)> = keys.iter().zip(notes).map(|(k, n)| (k.as_str(), Some(n.title.as_str()))).collect();
    options.push(("none", Some("none of them holds it")));
    let mut q = Map::new();
    q.insert("note".into(), jev::choice("Which of `notes` ({me}'s own notes) holds what the new messages ask {me} for? `none` when no note answers it.", &options));
    jev::for_user(&mut q, &me.name);
    match jev.ask(&state, q).await {
        Ok(a) => a.choice("note").and_then(|(k, p)| keys.iter().position(|x| *x == k).map(|i| (i, p))).filter(|(_, p)| *p >= ASKED_AT),
        Err(e) => {
            log::warn!("pigeon tell: which note on {}: {e:#}", conv.id);
            None
        }
    }
}

/// Notes: of the notes the user shares, the one that holds what they ask (`asked`: the new
/// messages' words), if any. One the chat holds: a use. One only others hold: a 🔑 card. None,
/// or nothing shared with anyone: nothing.
async fn from_notes(st: &State, conv: &Conversation, me: &Owner, book: &Book, tool: &'static Tool, p: f64, asked: &str, out: &mut Round) -> anyhow::Result<()> {
    let user = conv.user_id.as_str();
    let everyones = book.shared();
    if everyones.is_empty() || asked.trim().is_empty() {
        return Ok(());
    }
    let held = book.notes(&access::holders_of(conv));
    let theirs: Vec<Target> = held.iter().map(|e| e.target.clone()).collect();
    let mut notes = shared::search(st, user, &theirs, asked, NOTE_PICKS).await?;
    // and what only others hold: the user is asked before any of it is told
    for n in shared::search(st, user, &everyones, asked, 2 * NOTE_PICKS).await? {
        if notes.len() < 2 * NOTE_PICKS as usize && !theirs.iter().any(|t| shared::covers(t, &n)) {
            notes.push(n);
        }
    }
    let Some((i, sure)) = (if notes.is_empty() { None } else { pick(st, conv, me, asked, &notes).await }) else {
        asked_event(conv, tool.name, p, "no note");
        return Ok(());
    };
    let note = &notes[i];
    // shared on its own and through a folder: on its own counts
    let mut covering = held.iter().filter(|e| shared::covers(&e.target, note));
    let Some(first) = covering.next() else {
        asked_event(conv, tool.name, p, "uncovered");
        out.uncovered.push(Uncovered { tool, jev: p.min(sure), note: Some((note.id, note.title.clone())) });
        return Ok(());
    };
    let eff = if first.auto { first } else { covering.find(|e| e.auto).unwrap_or(first) };
    let mut u = blank(tool, eff.permission.clone(), Some(eff.grant), via_of(eff), p.min(sure), false);
    let whole = of_note(&mut u, tool, note, me);
    u.auto = eff.auto && p >= SURE_AT && sure >= SURE_AT && whole;
    if eff.auto && !u.auto {
        u.waits = Some(if whole { format!("Jev was {:.0}% sure, under the {:.0}% to send it by itself", p.min(sure) * 100.0, SURE_AT * 100.0) } else { "the note is too long to be given whole".to_string() });
    }
    asked_event(conv, tool.name, p, if u.auto { "auto" } else { "ask" });
    out.uses.push(u);
    Ok(())
}

/// What the new messages (`asked`: their words) ask for, against what the chat holds: the uses
/// the responder is given, and what's asked without leave. Nothing at all while sharing is paused.
pub async fn round(st: &State, conv: &Conversation, me: &Owner, answers: &Answers, asked: &str) -> anyhow::Result<Round> {
    let user = conv.user_id.as_str();
    let mut out = Round::default();
    if access::paused(&st.pool, user).await?.is_some() {
        return Ok(out);
    }
    let book = Book::load(&st.pool, user).await?;
    let effs = book.effective(&access::holders_of(conv));
    for tool in offer::TOOLS.iter().filter(|t| t.live) {
        let p = answers.yes(&format!("tool_{}", tool.name)).unwrap_or(0.0);
        if p < ASKED_AT {
            continue;
        }
        if tool.targets {
            from_notes(st, conv, me, &book, tool, p, asked, &mut out).await?;
            continue;
        }
        let held = access::held(&effs, tool.name);
        let Some(ask) = held.ask else {
            asked_event(conv, tool.name, p, "uncovered");
            out.uncovered.push(Uncovered { tool, jev: p, note: None });
            continue;
        };
        // on its own only up to where auto reaches; with the user's tap, up to where ask does
        let sure = held.auto.as_ref().filter(|_| p >= SURE_AT);
        let eff = sure.unwrap_or(&ask);
        let Some(said) = say(st, user, me, tool, eff.level).await? else {
            asked_event(conv, tool.name, p, "nothing known");
            out.unknown.push(tool);
            continue;
        };
        let mut u = blank(tool, eff.permission.clone(), Some(eff.grant), eff.from.words(), p, sure.is_some() && !said.stale);
        put(&mut u, tool, said);
        asked_event(conv, tool.name, p, if u.auto { "auto" } else { "ask" });
        out.uses.push(u);
    }
    Ok(out)
}

/// What a tool gives, said of the user by name: "where Anna is right now".
pub fn gives(tool: &Tool, name: &str) -> String {
    tool.gives.replace("you're", &format!("{name} is")).replace("you are", &format!("{name} is")).replace("you ", &format!("{name} ")).replace(" of yours", &format!(" of {name}'s"))
}

/// What the user reads when they ask for something they hold and Pigeon knows nothing to say.
pub fn unknown(tool: &Tool, them: &str) -> String {
    match tool.name {
        "location" => format!("📍 {them} asks where you are and may know it, but Pigeon can't tell them: your phone hasn't told it. Switch your place on in the app (Settings > Access)."),
        _ => format!("{them} asks {} and may know it, but Pigeon knows nothing to tell them.", tool.gives),
    }
}

fn asked_event(conv: &Conversation, tool: &str, p: f64, outcome: &str) {
    Event::new("pigeon", "tool_asked", Severity::Info)
        .user_id(&conv.user_id)
        .entity("conversation", conv.id)
        .attrs(json!({ "tool": tool, "p": p, "outcome": outcome, "channel": conv.connector }))
        .emit();
}

/// The newest messages someone wrote in a chat, as Jev reads them (outside a triage).
async fn newest(st: &State, conv: &Conversation, me: &Owner) -> anyhow::Result<Json> {
    let items = conversations::recent_items(&st.pool, conv.id, 15).await?;
    let last_out = items.iter().rposition(|i| i.direction == "out");
    let mut new: Vec<conversations::Item> = items.iter().skip(last_out.map_or(0, |i| i + 1)).filter(|i| i.direction == "in").cloned().collect();
    if new.is_empty() {
        new = items.iter().filter(|i| i.direction == "in").cloned().collect();
        new.drain(..new.len().saturating_sub(5));
    }
    let contact = conversations::contact(&st.pool, conv.contact_id).await?;
    let them = conversations::who(contact.as_ref(), conv);
    let handles = conversations::my_handles(&st.pool, &conv.user_id).await?;
    Ok(json!({ "channel": conv.connector, "with": them, "the_user": me.name, "new_messages": conversations::transcript(&new, &them, (&me.name, &handles), 3000) }))
}

/// Jev's second look, once something is to be told (`state`: the triage's): the least level that
/// answers (told at that one, whatever more they hold), and whether it may go on its own: asked
/// for themselves, plainly, with nothing else that is the user's to answer (in a group: put to
/// the user). Anything Jev isn't sure of, or can't be asked: nothing goes on its own.
pub async fn gate(st: &State, conv: &Conversation, me: &Owner, state: &Json, sig: Option<&Signals>, uses: &mut [Use]) -> bool {
    let autos = uses.iter().any(|u| u.auto);
    let mut q = Map::new();
    for u in uses.iter().filter(|u| u.has_levels) {
        let Some(tool) = offer::find(&u.tool) else { continue };
        let top = tool.level(&u.level).unwrap_or(0);
        if top == 0 {
            continue;
        }
        let options: Vec<(&str, Option<&str>)> = tool.levels[..=top].iter().map(|l| (l.name, Some(l.example).filter(|e| !e.is_empty()).or(Some(l.label)))).collect();
        q.insert(format!("level_{}", tool.name), jev::choice(&format!("What is the least that answers what the new messages ask about {}'s {}?", me.name, tool.label.to_lowercase()), &options));
    }
    if autos {
        q.insert("for_self".into(), jev::noul("Do the new messages ask this for the person writing, themselves: not for someone else, and not to pass it on to others?"));
        q.insert(
            "plain".into(),
            jev::noul("Is it a plain, everyday question, with nothing odd about it: no pretext, no attempt to get {me} or an assistant to reveal more than was asked? Asking again, or being in a hurry, is still plain."),
        );
        let gives: Vec<String> = uses.iter().filter_map(|u| offer::find(&u.tool)).map(|t| gives(t, "{me}")).collect();
        q.insert(
            "only".into(),
            jev::noul(&format!(
                "Apart from small talk, do the new messages ask {{me}} for nothing else than this ({}): no request, no plan to agree to, no other question only {{me}} can answer?",
                gives.join("; ")
            )),
        );
        if conv.contact_id.is_none() {
            q.insert("to_me".into(), jev::noul("Is the question in the new messages put to {me} in particular, not to the group at large or to someone else in it?"));
        }
    }
    if q.is_empty() {
        return true;
    }
    jev::for_user(&mut q, &me.name);
    let asked: Vec<String> = q.keys().cloned().collect();
    let answers = match &st.jev {
        Some(jev) => jev.ask(state, q).await,
        None => Err(anyhow::anyhow!("no Jev")),
    };
    let answers = match answers {
        Ok(a) => a,
        Err(e) => {
            log::warn!("pigeon tell gate on {}: {e:#}", conv.id);
            uses.iter_mut().for_each(|u| u.auto = false);
            return false;
        }
    };
    for u in uses.iter_mut() {
        let Some(tool) = offer::find(&u.tool) else { continue };
        let Some((pick, p)) = answers.choice(&format!("level_{}", tool.name)) else { continue };
        let (Some(least), Some(now)) = (tool.level(&pick), tool.level(&u.level)) else { continue };
        if p < 0.5 || least >= now {
            continue;
        }
        match say(st, &conv.user_id, me, tool, least).await {
            Ok(Some(said)) => {
                let auto = u.auto && !said.stale;
                put(u, tool, said);
                u.auto = auto;
            }
            Ok(None) => {}
            Err(e) => log::warn!("pigeon tell gate on {}: {e:#}", conv.id),
        }
    }
    if !autos {
        return true;
    }
    let sure = |k: &str| !asked.iter().any(|a| a == k) || answers.yes(k).unwrap_or(0.0) >= SURE_AT;
    // asking again, or in a hurry, reads as pressing: no reason to keep from them what they hold
    // on auto (sensitive and others on it still are)
    let calm = sig.is_none_or(|s| s.sensitive < HOLD_AT && s.others.is_empty());
    let open = sure("for_self") && sure("plain") && sure("only") && sure("to_me") && calm;
    if !open {
        uses.iter_mut().for_each(|u| u.auto = false);
    }
    Event::new("pigeon", "tool_gate", Severity::Info)
        .user_id(&conv.user_id)
        .entity("conversation", conv.id)
        .attrs(json!({
            "tools": uses.iter().map(|u| u.tool.clone()).collect::<Vec<_>>(),
            "for_self": answers.yes("for_self"), "plain": answers.yes("plain"), "only": answers.yes("only"), "to_me": answers.yes("to_me"),
            "calm": calm, "open": open,
        }))
        .emit();
    true
}

/// For the agent's context: what it may tell them, and how far.
pub fn brief(uses: &[Use], me: &str, them: &str) -> String {
    let mut s = format!("\nWhat {me} lets Pigeon tell {them} (they asked for it; use only this, and only as far as it answers what they asked):\n");
    for u in uses {
        s.push_str(&format!("- {}{}: {}\n", u.label, if u.has_levels { format!(" ({})", u.level_label.to_lowercase()) } else { String::new() }, u.how));
    }
    s
}

/// The record a reply carries (`args.used`).
pub fn record(uses: &[Use]) -> Json {
    json!(uses)
}

/// A reply's record, read back.
pub fn used(args: &Json) -> Vec<Use> {
    args.get("used").cloned().and_then(|v| serde_json::from_value(v).ok()).unwrap_or_default()
}

/// "Place · City (from Friends)": a record in a line.
pub fn line(uses: &[Use]) -> String {
    uses.iter()
        .map(|u| if u.has_levels { format!("{} · {} ({})", u.label, u.level_label, u.via) } else { format!("{} ({})", u.label, u.via) })
        .collect::<Vec<_>>()
        .join(", ")
}

/// Why a reply written with these must wait for the user, if it must: it gives a card number
/// from a note, it says something finer than they hold, something about the user it wasn't
/// given, or it promises. Jev reads it back; when it can't, the reply waits. `also`: what else
/// the reply may say of the user (that they're away).
pub async fn leaks(st: &State, conv: &Conversation, me: &Owner, uses: &[Use], also: Option<&str>, text: &str) -> Option<String> {
    let low = text.to_lowercase();
    let why = match uses.iter().find(|u| u.beyond.iter().any(|b| low.contains(b.as_str()))) {
        Some(u) => Some(format!("it says more than {} allows", u.label.to_lowercase())),
        None if uses.iter().any(|u| u.note_id.is_some()) && shared::card(text) => Some("it gives a card number".to_string()),
        None => {
            let mut allowed: Vec<Json> = uses
                .iter()
                .map(|u| match &u.only {
                    Some(only) => json!({ "about": u.label, "knows": u.told, "may_say_only": only }),
                    None => json!({ "about": u.label, "may_say": u.whole.as_deref().unwrap_or(&u.told) }),
                })
                .collect();
            if let Some(a) = also {
                allowed.push(json!({ "about": "also fine to say", "may_say": a }));
            }
            let state = json!({ "reply": text, "allowed": allowed });
            let mut q = Map::new();
            q.insert(
                "beyond".into(),
                jev::noul(
                    "Does `reply` state a fact about {me} or of {me}'s (where {me} is, what {me} is doing, {me}'s schedule or plans, who {me} is with, an address, a code, a number, a detail) that `allowed` doesn't contain, more precisely than `allowed` has it, or, where an entry has `may_say_only`, anything of its `knows` beyond that?",
                ),
            );
            q.insert("promises".into(), jev::noul("Does `reply` agree to, accept, promise or decline something on {me}'s behalf (a meeting, a call, a time, a favour, a plan)? Saying {me} will see their message is no."));
            jev::for_user(&mut q, &me.name);
            match &st.jev {
                None => Some("it couldn't be checked".to_string()),
                Some(jev) => match jev.ask(&state, q).await {
                    Err(e) => {
                        log::warn!("pigeon tell check on {}: {e:#}", conv.id);
                        Some("it couldn't be checked".to_string())
                    }
                    Ok(a) => {
                        let (beyond, promises) = (a.yes("beyond").unwrap_or(1.0), a.yes("promises").unwrap_or(1.0));
                        if beyond >= LEAK_AT {
                            Some(format!("it may say more than you allow ({beyond:.2})"))
                        } else if promises >= LEAK_AT {
                            Some(format!("it may agree to something for you ({promises:.2})"))
                        } else {
                            None
                        }
                    }
                },
            }
        }
    };
    if let Some(w) = &why {
        Event::new("pigeon", "tool_leak", Severity::Warn)
            .user_id(&conv.user_id)
            .entity("conversation", conv.id)
            .attrs(json!({ "tools": uses.iter().map(|u| u.tool.clone()).collect::<Vec<_>>(), "why": w }))
            .emit();
    }
    why
}

/// How sure Jev is that the user's answer to Pigeon says to send the person where the user is (a
/// pin on the map). 0 when Jev can't be asked: the pin then waits for the user.
pub async fn asks_place(st: &State, conv: &Conversation, me: &Owner, asked: &str, answer: &str) -> f64 {
    let Some(jev) = &st.jev else { return 0.0 };
    let state = json!({ "pigeon_asked": asked, "answer": answer });
    let mut q = Map::new();
    q.insert("place".into(), jev::noul("Does `answer`, {me}'s answer to what Pigeon asked, tell Pigeon to send them where {me} is (their location, their position, a pin on the map)?"));
    jev::for_user(&mut q, &me.name);
    match jev.ask(&state, q).await {
        Ok(a) => a.yes("place").unwrap_or(0.0),
        Err(e) => {
            log::warn!("pigeon place check on {}: {e:#}", conv.id);
            0.0
        }
    }
}

// ── the 🔑 card: asked, and they don't hold it ──────────────────────────────

/// Who would hold it: the chat's person, or the chat itself in a group.
fn holder_of(conv: &Conversation) -> Holder {
    match conv.contact_id {
        Some(c) => Holder::Contact(c),
        None => Holder::Conversation(conv.id),
    }
}

/// The card: kept with the questions (`options.uncovered` says what it is), drawn by `cards`.
pub async fn uncovered_card(st: &State, conv: &Conversation, them: &str, u: &Uncovered) -> anyhow::Result<Uuid> {
    let h = holder_of(conv);
    let mut data = json!({ "tool": u.tool.name, "label": u.tool.label, "gives": u.tool.gives, "jev": u.jev, "holder": { "kind": h.kind(), "id": h.id(), "name": them } });
    let question = match &u.note {
        Some((id, title)) => {
            data["note"] = json!({ "id": id, "title": title });
            format!("{them} asks for something that is in your note «{title}». Pigeon may not tell them.")
        }
        None => format!("{them} asks {}. Pigeon may not tell them.", u.tool.gives),
    };
    Ok(sqlx::query_scalar("INSERT INTO db_pigeon_questions (conversation_id, question, options) VALUES ($1, $2, $3) RETURNING id")
        .bind(conv.id)
        .bind(question)
        .bind(json!({ "uncovered": data }))
        .fetch_one(&st.pool)
        .await?)
}

/// The card pressed. `once`: answer with it this time (`text`: up to which level; else what
/// answers the question); `allow` with `text` a permission: grant it to them, then answer (a
/// note's card: that note); `granted`: the app granted it itself, answer by what they now hold;
/// `x`: no. The reply comes as a draft.
pub async fn press(st: &AppState, user: &str, id: Uuid, button: &str, text: Option<&str>) -> anyhow::Result<String> {
    let row: Option<(Uuid, Json)> = sqlx::query_as(
        "SELECT q.conversation_id, q.options FROM db_pigeon_questions q JOIN db_pigeon_conversations c ON c.id = q.conversation_id
          WHERE q.id = $1 AND c.user_id = $2 AND q.status = 'open'",
    )
    .bind(id)
    .bind(user)
    .fetch_optional(&st.pool)
    .await?;
    let Some((conversation, options)) = row else { anyhow::bail!("that card is gone") };
    let tool = options["uncovered"]["tool"].as_str().and_then(offer::find).ok_or_else(|| anyhow::anyhow!("that card is gone"))?;
    let p = options["uncovered"]["jev"].as_f64().unwrap_or(0.0);
    if button == "x" {
        cards::drop_question(st, id).await?;
        return Ok("🗑 Dropped".into());
    }
    if access::paused(&st.pool, user).await?.is_some() {
        anyhow::bail!("Telling is paused: resume it first");
    }
    let conv = tools::own_conversation(st, user, conversation).await?;
    let me = owner::get(&st.pool, user).await;
    if tool.targets {
        return press_note(st, user, id, &conv, &me, tool, &options["uncovered"], button, text).await;
    }
    let (mut u, answer) = match button {
        "once" => {
            let top = match text {
                Some(l) => tool.level(l).ok_or_else(|| anyhow::anyhow!("{}'s levels: {}", tool.name, tool.levels.iter().map(|l| l.name).collect::<Vec<_>>().join(", ")))?,
                None => tool.levels.len() - 1,
            };
            let mut u = blank(tool, format!("{}.{}.ask", tool.name, tool.levels[top].name), None, "this once".into(), p, false);
            u.level = tool.levels[top].name.to_string();
            (u, "Tell them, this once".to_string())
        }
        "allow" | "granted" => {
            if button == "allow" {
                let name = text.ok_or_else(|| anyhow::anyhow!("choose what to allow"))?;
                let perm = Permission::parse(name)?;
                if perm.reach(tool).is_none() {
                    anyhow::bail!("{name} isn't about {}", tool.label.to_lowercase());
                }
                access::grant(st, user, holder_of(&conv), &What::Permission(perm.name()), None, None, Some("allowed from the card")).await?;
            }
            let held = access::held(&access::for_chat(st, &conv).await?, tool.name);
            let eff = held.ask.ok_or_else(|| anyhow::anyhow!("they still don't hold it"))?;
            let mut u = blank(tool, eff.permission.clone(), Some(eff.grant), eff.from.words(), p, false);
            u.level = eff.level_name().to_string();
            (u, format!("Allowed: {}", eff.name()))
        }
        _ => anyhow::bail!("not a choice: {button}"),
    };
    let top = tool.level(&u.level).unwrap_or(0);
    let said = say(st, user, &me, tool, top).await?;
    // pressed twice at once: the first one writes
    let taken = sqlx::query("UPDATE db_pigeon_questions SET status = 'answered', answer = $2, answered_by = 'user (Inbox)', answered_at = NOW() WHERE id = $1 AND status = 'open'")
        .bind(id)
        .bind(&answer)
        .execute(&st.pool)
        .await?;
    if taken.rows_affected() == 0 {
        anyhow::bail!("that card is gone");
    }
    events::conversation(&st.pool, conversation).await;
    let Some(said) = said else {
        return Ok(format!("Pigeon doesn't know {} right now: nothing written.", tool.gives));
    };
    put(&mut u, tool, said);
    let mut uses = vec![u];
    // no more than answers what they asked, unless the user chose the level
    if !(button == "once" && text.is_some()) {
        let asked = match newest(st, &conv, &me).await {
            Ok(state) => gate(st, &conv, &me, &state, None, &mut uses).await,
            Err(e) => {
                log::warn!("pigeon tell on {conversation}: {e:#}");
                false
            }
        };
        // this once, no level chosen and Jev not there to say how much answers: the least
        if button == "once" && !asked && tool.has_levels() {
            match say(st, user, &me, tool, 0).await {
                Ok(Some(said)) => put(&mut uses[0], tool, said),
                Ok(None) => {}
                Err(e) => log::warn!("pigeon tell on {conversation}: {e:#}"),
            }
        }
    }
    cards::act_on(st, conversation, cards::Said::Tell(uses));
    Ok("Got it: Pigeon is writing it.".into())
}

/// A note's 🔑 card pressed: `once` answers from that note this time; `allow` (`text`:
/// notes.use.ask or notes.use.auto) shares the note with them, then answers; `granted`: the app
/// shared it (the note, or a folder it is in). Always a draft.
#[allow(clippy::too_many_arguments)]
async fn press_note(st: &AppState, user: &str, id: Uuid, conv: &Conversation, me: &Owner, tool: &'static Tool, card: &Json, button: &str, text: Option<&str>) -> anyhow::Result<String> {
    let note = card["note"]["id"].as_str().and_then(|s| Uuid::parse_str(s).ok()).ok_or_else(|| anyhow::anyhow!("that card is gone"))?;
    let p = card["jev"].as_f64().unwrap_or(0.0);
    let Some(n) = shared::read(st, user, note).await? else { anyhow::bail!("that note is gone, or it is in {} now: nothing to tell", crate::apps::pigeon::folder::ROOT) };
    let (mut u, answer) = match button {
        "once" => (blank(tool, format!("{}.{}.ask", tool.name, tool.levels[0].name), None, "this once".into(), p, false), "Tell them, this once".to_string()),
        "allow" | "granted" => {
            if button == "allow" {
                let perm = Permission::parse(text.ok_or_else(|| anyhow::anyhow!("choose what to allow"))?)?;
                if perm.reach(tool).is_none() {
                    anyhow::bail!("{} isn't about {}", perm.name(), tool.label.to_lowercase());
                }
                access::grant(st, user, holder_of(conv), &What::Permission(perm.name()), Some(&Target::Note(note)), None, Some("allowed from the card")).await?;
            }
            let held = Book::load(&st.pool, user).await?.notes(&access::holders_of(conv));
            let eff = held.iter().find(|e| shared::covers(&e.target, &n)).ok_or_else(|| anyhow::anyhow!("they still don't hold it"))?;
            (blank(tool, eff.permission.clone(), Some(eff.grant), via_of(eff), p, false), format!("Allowed: {}", eff.permission))
        }
        _ => anyhow::bail!("not a choice: {button}"),
    };
    // pressed twice at once: the first one writes
    let taken = sqlx::query("UPDATE db_pigeon_questions SET status = 'answered', answer = $2, answered_by = 'user (Inbox)', answered_at = NOW() WHERE id = $1 AND status = 'open'")
        .bind(id)
        .bind(&answer)
        .execute(&st.pool)
        .await?;
    if taken.rows_affected() == 0 {
        anyhow::bail!("that card is gone");
    }
    events::conversation(&st.pool, conv.id).await;
    of_note(&mut u, tool, &n, me);
    cards::act_on(st, conv.id, cards::Said::Tell(vec![u]));
    Ok("Got it: Pigeon is writing it.".into())
}

// ── once a reply that used something is decided ────────────────────────────

/// Whether the user's yes sends Pigeon's words as it wrote them (`edits`: what the approval
/// changes; `edited`: they redrafted it before).
pub fn as_written(row: &ActionRow, edits: Option<&Json>) -> bool {
    let changed = edits.and_then(|e| e.get("text")).is_some_and(|t| t.as_str().map(str::trim) != row.args["text"].as_str().map(str::trim));
    row.kind == "reply" && row.args.get("used").is_some() && !changed && row.args.get("edited").and_then(Json::as_bool) != Some(true)
}

/// A reply that used something went out: when the user sent it as Pigeon wrote it for the third
/// time through one ask grant, Pigeon proposes auto for it (a card: the user's tap decides).
pub async fn sent(st: &State, row: &ActionRow) {
    let uses = used(&row.args);
    if uses.is_empty() {
        return;
    }
    let as_written = row.args.get("as_written").and_then(Json::as_bool) == Some(true);
    for u in &uses {
        Event::new("pigeon", "tool_told", Severity::Info)
            .user_id(&row.user_id)
            .entity("action", row.id)
            .attrs(json!({ "tool": u.tool, "level": u.level, "auto": row.policy == "auto", "as_written": as_written, "via": u.via, "p": u.jev, "stale": u.stale }))
            .emit();
    }
    if as_written {
        for u in uses.iter().filter(|u| u.grant_id.is_some()) {
            if let Err(e) = suggest_auto(st, row, u).await {
                log::warn!("pigeon tell: suggesting auto after {}: {e:#}", row.id);
            }
        }
    }
}

async fn suggest_auto(st: &State, row: &ActionRow, u: &Use) -> anyhow::Result<()> {
    let (Some(grant), Some(tool)) = (u.grant_id, offer::find(&u.tool)) else { return Ok(()) };
    if tool.ask_only {
        return Ok(());
    }
    let n: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM db_pigeon_actions WHERE user_id = $1 AND kind = 'reply' AND status = 'done'
            AND args->'as_written' = 'true'::jsonb AND args->'used' @> $2::jsonb",
    )
    .bind(&row.user_id)
    .bind(json!([{ "grant_id": grant, "tool": tool.name }]))
    .fetch_one(&st.pool)
    .await?;
    if n != SUGGEST_AFTER {
        return Ok(());
    }
    // the grant as it stands: still theirs, still asking
    let book = Book::load(&st.pool, &row.user_id).await?;
    let Some(g) = book.grants.iter().find(|g| g.id == grant) else { return Ok(()) };
    let Some(perm) = g.permission.as_deref().and_then(Permission::read).filter(|p| !p.auto()) else { return Ok(()) };
    let auto = Permission { mode: "auto".into(), ..perm };
    let h = g.holder();
    let what = What::Permission(auto.name());
    let target = g.target();
    let Some(summary) = access::on_its_own(st, &row.user_id, h, &what, target.as_ref()).await? else { return Ok(()) };
    let mut args = json!({ format!("{}_id", h.kind()): h.id(), "permission": auto.name(), "said": "suggested after three sent as written" });
    match &target {
        Some(Target::Note(n)) => args["note_id"] = json!(n),
        Some(Target::Folder(f)) => args["folder"] = json!(f),
        None => {}
    }
    let conversation = match h {
        Holder::Group(_) => None,
        _ => row.conversation_id,
    };
    confirm::ask(st, &row.user_id, "pigeon_grant", &args, &Tap { summary: format!("You sent it as Pigeon wrote it {SUGGEST_AFTER} times. {summary}"), conversation }).await?;
    Ok(())
}

/// "This was wrong", on a reply that used something (`tool`: only that one): the grants behind
/// it go back to ask, and the record says so.
pub async fn wrong(st: &State, user: &str, action: Uuid, tool: Option<&str>) -> anyhow::Result<Json> {
    let row = actions::get(st, action).await?.filter(|r| r.user_id == user).ok_or_else(|| anyhow::anyhow!("no such reply"))?;
    let mut uses = used(&row.args);
    if !uses.iter().any(|u| tool.is_none_or(|t| t == u.tool)) {
        anyhow::bail!("that reply used nothing{}", tool.map(|t| format!(" of {t}")).unwrap_or_default());
    }
    let book = Book::load(&st.pool, user).await?;
    let mut changed = Vec::new();
    let mut seen = HashSet::new();
    for u in uses.iter_mut().filter(|u| tool.is_none_or(|t| t == u.tool)) {
        u.wrong = true;
        Event::new("pigeon", "tool_wrong", Severity::Warn)
            .user_id(user)
            .entity("action", action)
            .attrs(json!({ "tool": u.tool, "level": u.level, "auto": row.policy == "auto", "via": u.via, "p": u.jev }))
            .emit();
        let Some(g) = u.grant_id.filter(|g| seen.insert(*g)).and_then(|id| book.grants.iter().find(|g| g.id == id)) else { continue };
        let Some(perm) = g.permission.as_deref().and_then(Permission::read).filter(|p| p.auto()) else { continue };
        let ask = Permission { mode: "ask".into(), ..perm };
        let target = g.target();
        match access::grant(st, user, g.holder(), &What::Permission(ask.name()), target.as_ref(), g.until, Some("back to ask: marked wrong")).await {
            Ok(v) => changed.push(v),
            // a note that can't be given again as it stands (in the trash, moved): no leave at all
            Err(e) if target.is_some() => {
                log::warn!("pigeon tell: back to ask on {}: {e:#}; taken back", g.id);
                changed.push(access::revoke(st, user, g.id).await?);
            }
            Err(e) => return Err(e),
        }
    }
    sqlx::query("UPDATE db_pigeon_actions SET args = jsonb_set(args, '{used}', $2), updated_at = NOW() WHERE id = $1").bind(action).bind(record(&uses)).execute(&st.pool).await?;
    if let Some(c) = row.conversation_id {
        events::conversation(&st.pool, c).await;
    }
    Ok(json!({ "changed": changed, "used": uses }))
}

/// The replies that used something, newest first: for one person, one chat, or everyone.
pub async fn uses(st: &State, user: &str, contact: Option<Uuid>, conversation: Option<Uuid>, limit: i64) -> anyhow::Result<Json> {
    let rows: Vec<(Uuid, Uuid, String, DateTime<Utc>, Option<String>, Json, Option<String>, Option<String>)> = sqlx::query_as(
        "SELECT a.id, a.conversation_id, a.status, COALESCE(a.decided_at, a.created_at), a.args->>'text', a.args->'used', ct.name, c.title
           FROM db_pigeon_actions a JOIN db_pigeon_conversations c ON c.id = a.conversation_id
           LEFT JOIN db_pigeon_contacts ct ON ct.id = c.contact_id
          WHERE a.user_id = $1 AND a.kind = 'reply' AND a.args ? 'used' AND a.status IN ('done', 'pending')
            AND ($2::uuid IS NULL OR c.contact_id = $2) AND ($3::uuid IS NULL OR a.conversation_id = $3)
          ORDER BY 4 DESC LIMIT $4",
    )
    .bind(user)
    .bind(contact)
    .bind(conversation)
    .bind(limit.clamp(1, 200))
    .fetch_all(&st.pool)
    .await?;
    let uses: Vec<Json> = rows
        .into_iter()
        .map(|(id, conversation_id, status, at, text, used, name, title)| {
            json!({ "action_id": id, "conversation_id": conversation_id, "who": name.or(title).unwrap_or_else(|| "someone".into()), "status": status, "at": at,
                    "text": text, "used": used })
        })
        .collect();
    Ok(json!({ "uses": uses }))
}

/// The record on the messages shown: each of Pigeon's sent replies that used something carries
/// `used` and its `action_id`.
pub async fn on_items(pool: &DbPool, items: &mut [Json]) {
    let ids: Vec<Uuid> = items.iter().filter(|i| i["direction"] == "out").filter_map(|i| i["id"].as_str().and_then(|s| Uuid::parse_str(s).ok())).collect();
    if ids.is_empty() {
        return;
    }
    let rows: Result<Vec<(Uuid, Uuid, Json)>, _> = sqlx::query_as(
        "SELECT i.id, a.id, a.args->'used' FROM db_pigeon_items i JOIN db_pigeon_actions a ON a.conversation_id = i.conversation_id
          WHERE i.id = ANY($1) AND a.kind = 'reply' AND a.status = 'done' AND a.args ? 'used'
            AND (a.result->>'message_id' = i.external_id OR (jsonb_typeof(a.result->'message_ids') = 'array' AND a.result->'message_ids' ? i.external_id))",
    )
    .bind(&ids)
    .fetch_all(pool)
    .await;
    match rows {
        Err(e) => log::warn!("pigeon tell: the record on items: {e:#}"),
        Ok(rows) => {
            for (item, action, used) in rows {
                let id = item.to_string();
                if let Some(o) = items.iter_mut().find(|i| i["id"].as_str() == Some(id.as_str())).and_then(Json::as_object_mut) {
                    o.insert("used".into(), used);
                    o.insert("action_id".into(), json!(action));
                }
            }
        }
    }
}

// ── before granting: what it would have done, and where someone belongs ─────────────────────

/// The people a group reaches: its own, and those of the groups in it.
fn people_of(book: &Book, group: Uuid, seen: &mut HashSet<Uuid>, out: &mut Vec<Uuid>) {
    if !seen.insert(group) {
        return;
    }
    for g in book.grants.iter().filter(|g| g.member_of == Some(group)) {
        match (g.contact_id, g.group_id) {
            (Some(c), _) => out.push(c),
            (_, Some(inner)) => people_of(book, inner, seen, out),
            _ => {}
        }
    }
}

/// A permission tried on what its holder wrote lately: which messages asked for it (Jev, one
/// by one), and what Pigeon would have done with each. Nothing is sent or changed.
pub async fn try_on_past(st: &State, user: &str, h: Holder, permission: &str, limit: i64) -> anyhow::Result<Json> {
    let perm = Permission::parse(permission)?;
    let tool = offer::find(&perm.tool).ok_or_else(|| anyhow::anyhow!("try one tool at a time: location.city.auto"))?;
    if tool.targets {
        anyhow::bail!("{} can't be tried: whether a note answers depends on the note", tool.label);
    }
    let auto = perm.reach(tool).is_some_and(|(_, auto)| auto);
    let jev = st.jev.as_ref().ok_or_else(|| anyhow::anyhow!("Jev isn't configured"))?;
    let me = owner::get(&st.pool, user).await;
    let (contacts, chats): (Vec<Uuid>, Vec<Uuid>) = match h {
        Holder::Contact(c) => {
            people::mine(st, user, c).await?;
            (vec![c], vec![])
        }
        Holder::Conversation(c) => {
            tools::own_conversation(st, user, c).await?;
            (vec![], vec![c])
        }
        Holder::Group(g) => {
            let book = Book::load(&st.pool, user).await?;
            if book.group(g).is_none() {
                anyhow::bail!("no such group");
            }
            let mut out = Vec::new();
            people_of(&book, g, &mut HashSet::new(), &mut out);
            (out, vec![])
        }
    };
    let rows: Vec<(Uuid, String, DateTime<Utc>, Option<String>, String)> = sqlx::query_as(
        "SELECT i.conversation_id, i.body, i.at, COALESCE(ct.name, i.sender_name, c.title), c.connector
           FROM db_pigeon_items i JOIN db_pigeon_conversations c ON c.id = i.conversation_id
           LEFT JOIN db_pigeon_contacts ct ON ct.id = c.contact_id
          WHERE c.user_id = $1 AND (c.contact_id = ANY($2) OR c.id = ANY($3)) AND i.direction = 'in' AND length(trim(i.body)) > 1
          ORDER BY i.at DESC LIMIT $4",
    )
    .bind(user)
    .bind(&contacts)
    .bind(&chats)
    .bind(limit.clamp(1, 60))
    .fetch_all(&st.pool)
    .await?;
    let question = tool.asks.replace("{me}", &me.name);
    let checked = rows.len();
    let judged: Vec<(usize, anyhow::Result<f64>)> = futures::stream::iter(rows.iter().enumerate())
        .map(|(i, (_, body, _, who, connector))| {
            let state = json!({ "channel": connector, "with": who, "the_user": me.name, "new_messages": conversations::clip(body, 1500) });
            let mut q = Map::new();
            q.insert("asks".into(), jev::noul(&question));
            async move { (i, jev.ask(&state, q).await.map(|a| a.yes("asks").unwrap_or(0.0))) }
        })
        .buffer_unordered(6)
        .collect()
        .await;
    let mut messages: Vec<(usize, Json)> = Vec::new();
    let (mut asked, mut answered) = (0, 0);
    for (i, p) in judged {
        let p = p?;
        if p < ASKED_AT {
            continue;
        }
        asked += 1;
        let would = if auto && p >= SURE_AT { "answer" } else { "ask you" };
        if would == "answer" {
            answered += 1;
        }
        let (conversation, body, at, who, _) = &rows[i];
        messages.push((i, json!({ "conversation_id": conversation, "who": who, "at": at, "text": conversations::clip(body, 300), "p": p, "would": would })));
    }
    messages.sort_by_key(|(i, _)| *i);
    Ok(json!({
        "permission": perm.name(),
        "checked": checked,
        "asked": asked,
        "answered": answered,
        "messages": messages.into_iter().map(|(_, m)| m).collect::<Vec<_>>(),
        "note": "On its own, Pigeon also checks the question is for themselves, plain and the only thing asked, and reads its reply back: fewer go out than `answered`.",
    }))
}

/// Which of the user's groups a person belongs in, from what Pigeon knows about them (Jev);
/// none when it isn't sure, or they're already in it.
pub async fn suggest_group(st: &State, user: &str, contact: Uuid) -> anyhow::Result<Json> {
    let c = people::mine(st, user, contact).await?;
    let book = Book::load(&st.pool, user).await?;
    let (Some(jev), false) = (&st.jev, book.groups.is_empty()) else { return Ok(json!({ "suggestion": null })) };
    let me = owner::get(&st.pool, user).await;
    let state = json!({
        "the_user": me.name,
        "person": c.name,
        "who_they_are_to_the_user": c.relationship.clone().unwrap_or_default(),
        "the_users_note_on_them": c.note.clone().unwrap_or_default(),
        "what_pigeon_knows_about_them": people::memory(st, c.id).await?.map(|m| m.memory).unwrap_or_default(),
    });
    let keys: Vec<String> = (0..book.groups.len()).map(|i| format!("g{i}")).collect();
    let says: Vec<String> = book.groups.iter().map(|g| format!("{}{}", g.name, g.description.as_deref().map(|d| format!(": {d}")).unwrap_or_default())).collect();
    let mut options: Vec<(&str, Option<&str>)> = keys.iter().zip(&says).map(|(k, d)| (k.as_str(), Some(d.as_str()))).collect();
    options.push(("none", Some("none of them fits, or too little is known")));
    let mut q = Map::new();
    q.insert("group".into(), jev::choice("Which of {me}'s groups of people does this person belong in?", &options));
    jev::for_user(&mut q, &me.name);
    let pick = jev.ask(&state, q).await?.choice("group");
    let found = pick.and_then(|(k, p)| keys.iter().position(|x| *x == k).map(|i| (&book.groups[i], p))).filter(|(_, p)| *p >= ASKED_AT);
    Ok(match found {
        Some((g, _)) if book.own(Holder::Contact(contact)).any(|x| x.member_of == Some(g.id)) => json!({ "suggestion": null }),
        Some((g, p)) => json!({ "suggestion": { "group_id": g.id, "group": g.name, "p": p } }),
        None => json!({ "suggestion": null }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn a_use(tool: &str, level_label: &str, via: &str) -> Use {
        let t = offer::find(tool).unwrap();
        let mut u = blank(t, format!("{tool}.*.ask"), Some(Uuid::new_v4()), via.into(), 0.9, true);
        u.level_label = level_label.into();
        u
    }

    #[test]
    fn what_a_finer_level_adds_is_what_a_reply_must_not_hold() {
        let more = vec!["Shibuya, Tokyo".to_string(), "2-21-1 Shibuya, Shibuya City, Tokyo".to_string()];
        assert_eq!(finer("Tokyo", &more), vec!["shibuya", "2-21-1 shibuya", "shibuya city"]);
        assert_eq!(finer("Japan", &["Tokyo".to_string()]), vec!["tokyo"]);
        assert!(finer("Shibuya, Tokyo", &[]).is_empty());
    }

    #[test]
    fn the_record_keeps_what_was_told_not_how() {
        let mut u = a_use("location", "City", "from Friends");
        u.told = "Tokyo".into();
        u.how = "Where F is right now: Tokyo".into();
        u.beyond = vec!["shibuya".into()];
        let kept = record(&[u]);
        assert_eq!(kept[0]["told"], "Tokyo");
        assert!(kept[0].get("how").is_none() && kept[0].get("beyond").is_none() && kept[0].get("wrong").is_none());
        let back = used(&json!({ "text": "in Tokyo", "used": kept }));
        assert_eq!(back.len(), 1);
        assert_eq!(line(&back), "Place · City (from Friends)");
        assert_eq!(line(&[a_use("notes", "Yes", "theirs")]), "Notes (theirs)");
        assert!(used(&json!({ "text": "hi" })).is_empty());
    }

    fn me() -> Owner {
        Owner { name: "Ada".into(), tz: chrono_tz::UTC }
    }

    #[test]
    fn a_note_is_told_whole_and_the_record_names_it() {
        let tool = offer::find("notes").unwrap();
        let n = shared::Note { id: Uuid::from_u128(9), title: "House in Lucca".into(), content: "Via delle Rose 4.\nDoor code 4821.\nWifi: casa-rose / limone2024".into(), folder: "/shared/house".into() };
        let mut u = blank(tool, "notes.use.auto".into(), Some(Uuid::from_u128(1)), "from Family, in /shared/house".into(), 0.9, false);
        assert!(of_note(&mut u, tool, &n, &me()));
        assert_eq!(u.label, "Notes · House in Lucca");
        assert!(u.how.contains("Door code 4821") && u.how.contains("Ada's note «House in Lucca»"));
        // the reply is read back against all of it
        assert_eq!(u.whole.as_deref(), Some(n.content.as_str()));
        let kept = record(&[u]);
        assert_eq!(kept[0]["note_id"], json!(n.id));
        assert!(kept[0].get("whole").is_none() && kept[0].get("how").is_none());
        let back = used(&json!({ "used": kept }));
        assert_eq!(back[0].note_id, Some(n.id));
        assert_eq!(line(&back), "Notes · House in Lucca (from Family, in /shared/house)");
    }

    #[test]
    fn a_note_cut_for_its_length_waits_for_the_user() {
        let tool = offer::find("notes").unwrap();
        let mut n = shared::Note { id: Uuid::from_u128(9), title: "Deposit".into(), content: "Pay the deposit to GB82 WEST 1234 5698 7654 32".into(), folder: "/shared".into() };
        let mut u = blank(tool, "notes.use.auto".into(), None, "their own".into(), 0.9, false);
        assert!(of_note(&mut u, tool, &n, &me()));
        n.content = "word ".repeat(NOTE_MAX);
        assert!(!of_note(&mut u, tool, &n, &me()));
        assert!(u.how.contains("the rest is cut"));
        assert_eq!(u.whole.as_ref().unwrap().chars().count(), NOTE_MAX);
    }

    #[test]
    fn what_a_tool_gives_said_of_the_user() {
        assert_eq!(gives(offer::find("location").unwrap(), "Ada"), "where Ada is right now");
        assert_eq!(gives(offer::find("notes").unwrap(), "Ada"), "what is in a note of Ada's");
    }
}

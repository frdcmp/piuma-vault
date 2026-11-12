//! Who may be told what: the people who write hold permissions (`offer`: `tool.level.mode`), on
//! their own, through the chat they write in, or through the user's groups (Family, Friends,
//! Work: data, nothing relies on one existing). Plain RBAC, in one table (`db_pigeon_grants`):
//! a row says who (a person, a chat, a group) holds what (a permission, or being in a group).
//!
//!   - a person's permissions = their own + their groups' + what those groups hold through the
//!     groups they sit in (`Book::effective`), each with where it comes from (`From`): the
//!     screens say "from Friends, through Family"
//!   - a 1:1 chat counts as its person (plus the chat's own grants); a group chat gets only the
//!     chat's own, never its members': what's said there is heard by everyone in it
//!   - allow only: someone who must hear nothing holds nothing. Where two ways give different
//!     levels, the higher one counts
//!   - a grant or a membership may end (`until`): the worker sweeps the ended ones (`sweep`), and
//!     they stop counting the moment they end
//!   - only the user grants: from the Inbox (their tap), or through a tool (Piuma, a script, an
//!     assistant over MCP), where anything Pigeon would then do on its own waits for their tap
//!     (`confirm`)
//!
//! The pause ("don't tell anyone anything for two hours") is a setting (`sharing_paused`).

use std::collections::{HashMap, HashSet, VecDeque};

use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value as Json};
use sqlx::FromRow;
use uuid::Uuid;

use crate::apps::pigeon::conversations::Conversation;
use crate::apps::pigeon::offer::{self, Permission, Tool};
use crate::apps::pigeon::state::State;
use crate::apps::pigeon::{avatars, events, facts, people, policy, tools};
use crate::db::db::DbPool;

/// A group's name, at most.
pub const MAX_NAME: usize = 60;
pub const MAX_DESCRIPTION: usize = 300;
/// The user's words kept with a grant, at most.
pub const MAX_SAID: usize = 300;
const PAUSE_KEY: &str = "sharing_paused";
/// The tool the phone writes for: where the user is.
const PLACE: &str = "location";

#[derive(Debug, Clone, Serialize, FromRow)]
pub struct Group {
    pub id: Uuid,
    #[serde(skip)]
    pub user_id: String,
    pub name: String,
    pub description: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, FromRow)]
pub struct Grant {
    pub id: Uuid,
    pub user_id: String,
    pub contact_id: Option<Uuid>,
    pub conversation_id: Option<Uuid>,
    pub group_id: Option<Uuid>,
    pub permission: Option<String>,
    pub member_of: Option<Uuid>,
    pub until: Option<DateTime<Utc>>,
    pub said: Option<String>,
    pub created_at: DateTime<Utc>,
}

const GROUP_COLS: &str = "id, user_id, name, description, created_at, updated_at";
const GRANT_COLS: &str = "id, user_id, contact_id, conversation_id, group_id, permission, member_of, until, said, created_at";

/// Who holds a grant.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Holder {
    Contact(Uuid),
    Conversation(Uuid),
    Group(Uuid),
}

impl Holder {
    pub fn kind(&self) -> &'static str {
        match self {
            Holder::Contact(_) => "contact",
            Holder::Conversation(_) => "conversation",
            Holder::Group(_) => "group",
        }
    }

    pub fn id(&self) -> Uuid {
        match self {
            Holder::Contact(i) | Holder::Conversation(i) | Holder::Group(i) => *i,
        }
    }
}

impl Grant {
    pub fn holder(&self) -> Holder {
        match (self.contact_id, self.conversation_id, self.group_id) {
            (Some(c), _, _) => Holder::Contact(c),
            (_, Some(c), _) => Holder::Conversation(c),
            (_, _, Some(g)) => Holder::Group(g),
            // the table's CHECK: one of the three is set
            _ => Holder::Group(Uuid::nil()),
        }
    }
}

/// What a holder is given.
#[derive(Debug, Clone)]
pub enum What {
    Permission(String),
    MemberOf(Uuid),
}

/// Where an effective permission comes from.
#[derive(Debug, Clone, PartialEq)]
pub enum From {
    /// the person's (or the group's) own grant
    Direct,
    /// the chat's own grant
    Chat,
    /// a group's: its name, and the groups between the holder and it (nearest first)
    Group { id: Uuid, name: String, through: Vec<String> },
}

impl From {
    pub fn words(&self) -> String {
        match self {
            From::Direct => "their own".into(),
            From::Chat => "this chat's".into(),
            From::Group { name, through, .. } if through.is_empty() => format!("from {name}"),
            From::Group { name, through, .. } => format!("from {name}, through {}", through.join(", ")),
        }
    }
}

/// One permission that counts for someone, and why.
#[derive(Debug, Clone)]
pub struct Eff {
    pub tool: &'static Tool,
    /// up to this level (an index into the tool's)
    pub level: usize,
    pub auto: bool,
    pub grant: Uuid,
    pub permission: String,
    pub from: From,
    /// the earliest end on the way (the grant's, a membership's)
    pub until: Option<DateTime<Utc>>,
}

impl Eff {
    pub fn level_name(&self) -> &'static str {
        self.tool.levels[self.level].name
    }

    /// The name of exactly what counts (`location.city.auto`), whatever wildcard gave it.
    pub fn name(&self) -> String {
        format!("{}.{}.{}", self.tool.name, self.level_name(), if self.auto { "auto" } else { "ask" })
    }

    pub fn view(&self) -> Json {
        let l = &self.tool.levels[self.level];
        let (from, group_id, group, through) = match &self.from {
            From::Direct => ("direct", None, None, vec![]),
            From::Chat => ("chat", None, None, vec![]),
            From::Group { id, name, through } => ("group", Some(*id), Some(name.clone()), through.clone()),
        };
        json!({
            "tool": self.tool.name, "label": self.tool.label, "gives": self.tool.gives, "has_levels": self.tool.has_levels(), "live": self.tool.live,
            "level": l.name, "level_label": l.label, "example": l.example,
            "mode": if self.auto { "auto" } else { "ask" },
            "permission": self.permission, "grant_id": self.grant,
            "from": from, "group_id": group_id, "group": group, "through": through, "origin": self.from.words(),
            "until": self.until,
        })
    }
}

/// What a person holds for one tool: up to where Pigeon may answer once the user taps, and up to
/// where on its own (never above `ask`: auto includes ask).
#[derive(Debug, Clone, Default)]
pub struct Held {
    pub ask: Option<Eff>,
    pub auto: Option<Eff>,
}

/// One user's groups and grants that still count, read once.
pub struct Book {
    pub groups: Vec<Group>,
    pub grants: Vec<Grant>,
}

/// A group someone is in, and the way there.
struct Reached {
    group: Uuid,
    /// the groups passed before it, nearest the holder first
    through: Vec<Uuid>,
    until: Option<DateTime<Utc>>,
}

fn sooner(a: Option<DateTime<Utc>>, b: Option<DateTime<Utc>>) -> Option<DateTime<Utc>> {
    match (a, b) {
        (Some(x), Some(y)) => Some(x.min(y)),
        (x, y) => x.or(y),
    }
}

impl Book {
    pub async fn load(pool: &DbPool, user: &str) -> anyhow::Result<Book> {
        let groups = sqlx::query_as(&format!("SELECT {GROUP_COLS} FROM db_pigeon_groups WHERE user_id = $1 ORDER BY lower(name)")).bind(user).fetch_all(pool).await?;
        let grants = sqlx::query_as(&format!("SELECT {GRANT_COLS} FROM db_pigeon_grants WHERE user_id = $1 AND (until IS NULL OR until > NOW()) ORDER BY created_at"))
            .bind(user)
            .fetch_all(pool)
            .await?;
        Ok(Book { groups, grants })
    }

    pub fn group(&self, id: Uuid) -> Option<&Group> {
        self.groups.iter().find(|g| g.id == id)
    }

    fn group_name(&self, id: Uuid) -> String {
        self.group(id).map(|g| g.name.clone()).unwrap_or_else(|| "a group".into())
    }

    pub fn own(&self, h: Holder) -> impl Iterator<Item = &Grant> {
        self.grants.iter().filter(move |g| g.holder() == h)
    }

    /// Every group a holder is in, each once, by the shortest way: their own groups first, then
    /// the groups those sit in.
    fn reached(&self, h: Holder) -> Vec<Reached> {
        let mut out: Vec<Reached> = Vec::new();
        let mut seen: HashSet<Uuid> = HashSet::new();
        let mut queue: VecDeque<Reached> =
            self.own(h).filter_map(|g| g.member_of.map(|m| Reached { group: m, through: vec![], until: g.until })).collect();
        while let Some(r) = queue.pop_front() {
            if Holder::Group(r.group) == h || !seen.insert(r.group) {
                continue;
            }
            for g in self.own(Holder::Group(r.group)) {
                if let Some(m) = g.member_of {
                    let mut through = r.through.clone();
                    through.push(r.group);
                    queue.push_back(Reached { group: m, through, until: sooner(r.until, g.until) });
                }
            }
            out.push(r);
        }
        out
    }

    /// Whether `group` sits (at any depth) in `in_group`.
    fn sits_in(&self, group: Uuid, in_group: Uuid) -> bool {
        self.reached(Holder::Group(group)).iter().any(|r| r.group == in_group)
    }

    /// What counts for these holders together (a person and the chat they write in): for each
    /// tool the highest level on its own, and the highest after a tap when that's higher. Among
    /// equals the nearest wins (their own, then the chat's, then the closest group).
    pub fn effective(&self, holders: &[Holder]) -> Vec<Eff> {
        // (the grant, its permission, where from, how far, until)
        let mut found: Vec<(&Grant, Permission, From, usize, Option<DateTime<Utc>>)> = Vec::new();
        for (i, h) in holders.iter().enumerate() {
            let from = if matches!(h, Holder::Conversation(_)) { From::Chat } else { From::Direct };
            for g in self.own(*h) {
                if let Some(p) = g.permission.as_deref().and_then(Permission::read) {
                    found.push((g, p, from.clone(), i, g.until));
                }
            }
            for r in self.reached(*h) {
                let from = From::Group { id: r.group, name: self.group_name(r.group), through: r.through.iter().map(|g| self.group_name(*g)).collect() };
                for g in self.own(Holder::Group(r.group)) {
                    if let Some(p) = g.permission.as_deref().and_then(Permission::read) {
                        found.push((g, p, from.clone(), holders.len() + r.through.len(), sooner(r.until, g.until)));
                    }
                }
            }
        }
        let mut out = Vec::new();
        for tool in offer::TOOLS {
            // the best: the highest level, then the nearest
            let best = |auto_only: bool| {
                found
                    .iter()
                    .filter_map(|(g, p, from, far, until)| p.reach(tool).filter(|(_, auto)| *auto || !auto_only).map(|(level, _)| (level, *far, g, p, from, until)))
                    .max_by(|a, b| a.0.cmp(&b.0).then(b.1.cmp(&a.1)))
            };
            let eff = |(level, _, g, p, from, until): (usize, usize, &&Grant, &Permission, &From, &Option<DateTime<Utc>>), auto: bool| Eff {
                tool,
                level,
                auto,
                grant: g.id,
                permission: p.name(),
                from: from.clone(),
                until: *until,
            };
            let auto = best(true).map(|b| eff(b, true));
            let ask = best(false).map(|b| eff(b, false));
            let above = match (&auto, &ask) {
                (Some(a), Some(k)) => k.level > a.level,
                (None, Some(_)) => true,
                _ => false,
            };
            out.extend(auto);
            if above {
                out.extend(ask);
            }
        }
        out
    }
}

/// What these effective permissions come to for one tool.
pub fn held(effs: &[Eff], tool: &str) -> Held {
    let auto = effs.iter().find(|e| e.tool.name == tool && e.auto).cloned();
    let ask = effs.iter().find(|e| e.tool.name == tool && !e.auto).cloned().or_else(|| auto.clone());
    Held { ask, auto }
}

/// The holders that count when someone writes in a chat: its person and the chat itself; in a
/// group chat (no one person), only the chat.
pub fn holders_of(conv: &Conversation) -> Vec<Holder> {
    match conv.contact_id {
        Some(c) => vec![Holder::Contact(c), Holder::Conversation(conv.id)],
        None => vec![Holder::Conversation(conv.id)],
    }
}

/// What counts in a chat, now.
pub async fn for_chat(st: &State, conv: &Conversation) -> anyhow::Result<Vec<Eff>> {
    Ok(Book::load(&st.pool, &conv.user_id).await?.effective(&holders_of(conv)))
}

// ── names, for the screens ───────────────────────────────────────────────

/// The people and chats that hold something, by id: who they are, in words.
#[derive(Default)]
struct Names {
    contacts: HashMap<Uuid, (String, Option<String>, Option<String>)>,
    chats: HashMap<Uuid, (String, String)>,
}

impl Names {
    async fn load(pool: &DbPool, book: &Book) -> anyhow::Result<Names> {
        let contacts: Vec<Uuid> = book.grants.iter().filter_map(|g| g.contact_id).collect();
        let chats: Vec<Uuid> = book.grants.iter().filter_map(|g| g.conversation_id).collect();
        let mut names = Names::default();
        if !contacts.is_empty() {
            let rows: Vec<(Uuid, Option<String>, Option<String>, Option<String>)> =
                sqlx::query_as("SELECT id, name, slug, avatar_key FROM db_pigeon_contacts WHERE id = ANY($1)").bind(&contacts).fetch_all(pool).await?;
            for (id, name, slug, avatar) in rows {
                let shown = name.or_else(|| slug.as_ref().map(|s| format!("@{s}"))).unwrap_or_else(|| "someone".into());
                names.contacts.insert(id, (shown, slug, avatar));
            }
        }
        if !chats.is_empty() {
            let rows: Vec<(Uuid, String, Option<String>, Option<String>)> = sqlx::query_as(
                "SELECT c.id, c.connector, c.title, ct.name FROM db_pigeon_conversations c LEFT JOIN db_pigeon_contacts ct ON ct.id = c.contact_id WHERE c.id = ANY($1)",
            )
            .bind(&chats)
            .fetch_all(pool)
            .await?;
            for (id, connector, title, name) in rows {
                names.chats.insert(id, (name.or(title).unwrap_or_else(|| "a chat".into()), connector));
            }
        }
        Ok(names)
    }

    fn holder(&self, book: &Book, h: Holder) -> Json {
        let (name, connector) = match h {
            Holder::Contact(c) => (self.contacts.get(&c).map(|n| n.0.clone()).unwrap_or_else(|| "someone".into()), None),
            Holder::Conversation(c) => match self.chats.get(&c) {
                Some((n, k)) => (n.clone(), Some(k.clone())),
                None => ("a chat".into(), None),
            },
            Holder::Group(g) => (book.group_name(g), None),
        };
        json!({ "kind": h.kind(), "id": h.id(), "name": name, "connector": connector })
    }
}

fn grant_view(g: &Grant, book: &Book, names: &Names) -> Json {
    let mut v = json!({ "id": g.id, "holder": names.holder(book, g.holder()), "until": g.until, "said": g.said, "created_at": g.created_at });
    if let Some(raw) = &g.permission {
        let p = match Permission::read(raw) {
            Some(p) => p.view(),
            None => json!({ "permission": raw, "tool": raw, "label": raw, "level": "", "level_label": "", "has_levels": false, "mode": "ask", "known": false }),
        };
        if let (Some(v), Some(p)) = (v.as_object_mut(), p.as_object()) {
            v.extend(p.clone());
        }
    }
    if let Some(m) = g.member_of {
        v["member_of"] = json!({ "id": m, "name": book.group_name(m) });
    }
    v
}

/// A holder's own permission grants, for a screen.
fn own_views(book: &Book, names: &Names, h: Holder) -> Vec<Json> {
    book.own(h).filter(|g| g.permission.is_some()).map(|g| grant_view(g, book, names)).collect()
}

/// The groups a holder sits in directly: `[{grant_id, id, name, until}]`.
fn memberships(book: &Book, h: Holder) -> Vec<Json> {
    book.own(h)
        .filter_map(|g| g.member_of.map(|m| json!({ "grant_id": g.id, "id": m, "name": book.group_name(m), "until": g.until, "said": g.said })))
        .collect()
}

fn eff_views(effs: &[Eff]) -> Vec<Json> {
    effs.iter().map(Eff::view).collect()
}

// ── reading ──────────────────────────────────────────────────────────────

/// Everything about access at once, for the Access screen and the assistants: the catalogue,
/// the pause, the groups (who's in, what each holds), and what people and chats hold on their own.
pub async fn overview(st: &State, user: &str) -> anyhow::Result<Json> {
    let book = Book::load(&st.pool, user).await?;
    let names = Names::load(&st.pool, &book).await?;
    let groups: Vec<Json> = book
        .groups
        .iter()
        .map(|g| {
            let people = book.grants.iter().filter(|x| x.member_of == Some(g.id) && x.contact_id.is_some()).count();
            json!({
                "id": g.id, "name": g.name, "description": g.description, "people": people,
                "sits_in": memberships(&book, Holder::Group(g.id)),
                "permissions": own_views(&book, &names, Holder::Group(g.id)),
            })
        })
        .collect();
    // people and chats with grants of their own, by name
    let mut holders: Vec<Holder> = Vec::new();
    for g in book.grants.iter().filter(|g| g.permission.is_some() && g.group_id.is_none()) {
        if !holders.contains(&g.holder()) {
            holders.push(g.holder());
        }
    }
    let mut direct: Vec<Json> = holders
        .into_iter()
        .map(|h| {
            let mut v = names.holder(&book, h);
            v["grants"] = json!(own_views(&book, &names, h));
            v
        })
        .collect();
    direct.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_lowercase());
    // where the user is, as Pigeon knows it: null when nothing wrote it (the phone's switch is off)
    let place = match facts::latest(&st.pool, user, PLACE).await? {
        Some(f) => facts::views(&st.pool, &[f]).await?.pop().unwrap_or(Json::Null),
        None => Json::Null,
    };
    Ok(json!({
        "catalogue": offer::catalogue(),
        "paused": paused(&st.pool, user).await?,
        "auto_enabled": policy::auto_enabled(&st.pool, user).await?,
        "groups": groups,
        "direct": direct,
        "place": place,
        "place_fresh_minutes": offer::find(PLACE).and_then(|t| t.fresh),
    }))
}

/// One person: their groups, their own grants, and everything that counts for them with where
/// it comes from.
pub async fn of_contact(st: &State, user: &str, contact: Uuid) -> anyhow::Result<Json> {
    let c = people::mine(st, user, contact).await?;
    let book = Book::load(&st.pool, user).await?;
    let names = Names::load(&st.pool, &book).await?;
    let h = Holder::Contact(contact);
    Ok(json!({
        "contact_id": contact,
        "name": c.name,
        "groups": memberships(&book, h),
        "own": own_views(&book, &names, h),
        "effective": eff_views(&book.effective(&[h])),
        "passons": facts::views(&st.pool, &facts::left_for(&st.pool, user, contact).await?).await?,
    }))
}

/// One chat: its own grants, and what counts in it (its person's too; in a group chat, only
/// the chat's own).
pub async fn of_conversation(st: &State, user: &str, conversation: Uuid) -> anyhow::Result<Json> {
    let conv = tools::own_conversation(st, user, conversation).await?;
    let book = Book::load(&st.pool, user).await?;
    let names = Names::load(&st.pool, &book).await?;
    Ok(json!({
        "conversation_id": conversation,
        "contact_id": conv.contact_id,
        "group_chat": conv.contact_id.is_none(),
        "own": own_views(&book, &names, Holder::Conversation(conversation)),
        "effective": eff_views(&book.effective(&holders_of(&conv))),
        "passons": facts::views(&st.pool, &facts::passons(&st.pool, user, conv.contact_id, Some(conversation)).await?).await?,
    }))
}

/// One group: what it sits in, the groups in it, its people, what it holds and what it inherits.
pub async fn of_group(st: &State, user: &str, group: Uuid) -> anyhow::Result<Json> {
    let book = Book::load(&st.pool, user).await?;
    let g = book.group(group).ok_or_else(|| anyhow::anyhow!("no such group: {group}"))?;
    let names = Names::load(&st.pool, &book).await?;
    let h = Holder::Group(group);
    let links = avatars::Links::new(&st.pool).await;
    let mut people = Vec::new();
    for x in book.grants.iter().filter(|x| x.member_of == Some(group)) {
        let Some(c) = x.contact_id else { continue };
        let (name, slug, avatar) = names.contacts.get(&c).cloned().unwrap_or_else(|| ("someone".into(), None, None));
        let mut v = json!({ "grant_id": x.id, "contact_id": c, "name": name, "slug": slug, "until": x.until });
        links.add(&st.pool, avatar.as_deref(), &mut v).await;
        people.push(v);
    }
    people.sort_by_key(|v| v["name"].as_str().unwrap_or_default().to_lowercase());
    let inside: Vec<Json> = book
        .grants
        .iter()
        .filter(|x| x.member_of == Some(group))
        .filter_map(|x| x.group_id.map(|i| json!({ "grant_id": x.id, "id": i, "name": book.group_name(i), "until": x.until })))
        .collect();
    Ok(json!({
        "group": g,
        "sits_in": memberships(&book, h),
        "groups": inside,
        "people": people,
        "permissions": own_views(&book, &names, h),
        "effective": eff_views(&book.effective(&[h])),
    }))
}

pub async fn groups(st: &State, user: &str) -> anyhow::Result<Vec<Group>> {
    Ok(sqlx::query_as(&format!("SELECT {GROUP_COLS} FROM db_pigeon_groups WHERE user_id = $1 ORDER BY lower(name)")).bind(user).fetch_all(&st.pool).await?)
}

/// One of the user's groups, by its id or its name.
pub async fn find_group(st: &State, user: &str, id_or_name: &str) -> anyhow::Result<Group> {
    let s = id_or_name.trim();
    let row: Option<Group> = match Uuid::parse_str(s) {
        Ok(id) => sqlx::query_as(&format!("SELECT {GROUP_COLS} FROM db_pigeon_groups WHERE id = $1 AND user_id = $2")).bind(id).bind(user).fetch_optional(&st.pool).await?,
        Err(_) => sqlx::query_as(&format!("SELECT {GROUP_COLS} FROM db_pigeon_groups WHERE user_id = $1 AND lower(name) = lower($2)")).bind(user).bind(s).fetch_optional(&st.pool).await?,
    };
    row.ok_or_else(|| anyhow::anyhow!("no such group: {s}"))
}

async fn grant_row(st: &State, user: &str, id: Uuid) -> anyhow::Result<Grant> {
    sqlx::query_as(&format!("SELECT {GRANT_COLS} FROM db_pigeon_grants WHERE id = $1 AND user_id = $2"))
        .bind(id)
        .bind(user)
        .fetch_optional(&st.pool)
        .await?
        .ok_or_else(|| anyhow::anyhow!("no such grant: {id}"))
}

/// One grant as the screens show it.
pub async fn grant_of(st: &State, user: &str, id: Uuid) -> anyhow::Result<Json> {
    let g = grant_row(st, user, id).await?;
    let book = Book::load(&st.pool, user).await?;
    let names = Names::load(&st.pool, &Book { groups: vec![], grants: vec![g.clone()] }).await?;
    Ok(grant_view(&g, &book, &names))
}

// ── changing ─────────────────────────────────────────────────────────────

/// A new group, or one renamed (its id stays: nothing else changes).
pub async fn save_group(st: &State, user: &str, id: Option<Uuid>, name: Option<&str>, description: Option<&str>) -> anyhow::Result<Group> {
    let name = name.map(str::trim);
    if name.is_some_and(|n| n.is_empty() || n.chars().count() > MAX_NAME) {
        anyhow::bail!("a group's name is 1 to {MAX_NAME} characters");
    }
    let description = description.map(str::trim);
    if description.is_some_and(|d| d.chars().count() > MAX_DESCRIPTION) {
        anyhow::bail!("a group's description is {MAX_DESCRIPTION} characters at most");
    }
    let taken = |e: sqlx::Error| match e.as_database_error().and_then(|d| d.constraint()) {
        Some("idx_pigeon_groups_name") => anyhow::anyhow!("there's already a group with that name"),
        _ => anyhow::Error::from(e),
    };
    let g: Option<Group> = match id {
        Some(id) => sqlx::query_as(&format!(
            "UPDATE db_pigeon_groups SET name = COALESCE($3, name), description = CASE WHEN $4::text IS NULL THEN description ELSE NULLIF($4, '') END, updated_at = NOW()
              WHERE id = $1 AND user_id = $2 RETURNING {GROUP_COLS}"
        ))
        .bind(id)
        .bind(user)
        .bind(name)
        .bind(description)
        .fetch_optional(&st.pool)
        .await
        .map_err(taken)?,
        None => {
            let name = name.ok_or_else(|| anyhow::anyhow!("a group needs a name"))?;
            sqlx::query_as(&format!("INSERT INTO db_pigeon_groups (user_id, name, description) VALUES ($1, $2, NULLIF($3, '')) RETURNING {GROUP_COLS}"))
                .bind(user)
                .bind(name)
                .bind(description.unwrap_or(""))
                .fetch_optional(&st.pool)
                .await
                .map_err(taken)?
        }
    };
    let g = g.ok_or_else(|| anyhow::anyhow!("no such group"))?;
    events::publish(&st.pool, user, "access", None).await;
    Ok(g)
}

/// A group gone, with everything it held and everyone's place in it.
pub async fn delete_group(st: &State, user: &str, id: Uuid) -> anyhow::Result<Group> {
    let g: Option<Group> = sqlx::query_as(&format!("DELETE FROM db_pigeon_groups WHERE id = $1 AND user_id = $2 RETURNING {GROUP_COLS}"))
        .bind(id)
        .bind(user)
        .fetch_optional(&st.pool)
        .await?;
    let g = g.ok_or_else(|| anyhow::anyhow!("no such group: {id}"))?;
    events::publish(&st.pool, user, "access", None).await;
    log::info!("pigeon access: {user} deleted the group {}", g.name);
    Ok(g)
}

/// The holder is the user's own.
async fn own_holder(st: &State, user: &str, h: Holder) -> anyhow::Result<()> {
    match h {
        Holder::Contact(c) => people::mine(st, user, c).await.map(|_| ()),
        Holder::Conversation(c) => tools::own_conversation(st, user, c).await.map(|_| ()),
        Holder::Group(g) => find_group(st, user, &g.to_string()).await.map(|_| ()),
    }
}

/// Give a holder a permission, or put them in a group. A permission replaces the holder's own
/// for the same tool (one say per tool: "Place: city, on its own"); a membership given again
/// only changes its end. Returns the grant, as the screens show it.
pub async fn grant(st: &State, user: &str, h: Holder, what: &What, until: Option<DateTime<Utc>>, said: Option<&str>) -> anyhow::Result<Json> {
    own_holder(st, user, h).await?;
    if until.is_some_and(|u| u <= Utc::now()) {
        anyhow::bail!("the end is already past");
    }
    let said = said.map(str::trim).filter(|s| !s.is_empty()).map(|s| s.chars().take(MAX_SAID).collect::<String>());
    let (contact, conversation, group) = match h {
        Holder::Contact(c) => (Some(c), None, None),
        Holder::Conversation(c) => (None, Some(c), None),
        Holder::Group(g) => (None, None, Some(g)),
    };
    let mut tx = st.pool.begin().await?;
    let (permission, member_of) = match what {
        What::Permission(name) => {
            let p = Permission::parse(name)?;
            // the holder's say on this tool so far goes
            let own: Vec<(Uuid, String)> = sqlx::query_as(
                "SELECT id, permission FROM db_pigeon_grants WHERE user_id = $1 AND permission IS NOT NULL AND COALESCE(contact_id, conversation_id, group_id) = $2",
            )
            .bind(user)
            .bind(h.id())
            .fetch_all(&mut *tx)
            .await?;
            let gone: Vec<Uuid> = own.into_iter().filter(|(_, raw)| Permission::read(raw).is_none_or(|o| o.tool == p.tool)).map(|(id, _)| id).collect();
            sqlx::query("DELETE FROM db_pigeon_grants WHERE id = ANY($1)").bind(&gone).execute(&mut *tx).await?;
            (Some(p.name()), None)
        }
        What::MemberOf(m) => {
            if matches!(h, Holder::Conversation(_)) {
                anyhow::bail!("a chat isn't in a group: give the chat its own permissions");
            }
            find_group(st, user, &m.to_string()).await?;
            if let Holder::Group(g) = h {
                let book = Book::load(&st.pool, user).await?;
                if g == *m || book.sits_in(*m, g) {
                    anyhow::bail!("{} already sits in {}: a group can't hold itself", book.group_name(*m), book.group_name(g));
                }
            }
            sqlx::query("DELETE FROM db_pigeon_grants WHERE user_id = $1 AND member_of = $3 AND COALESCE(contact_id, group_id) = $2")
                .bind(user)
                .bind(h.id())
                .bind(m)
                .execute(&mut *tx)
                .await?;
            (None, Some(*m))
        }
    };
    let id: Uuid = sqlx::query_scalar(
        "INSERT INTO db_pigeon_grants (user_id, contact_id, conversation_id, group_id, permission, member_of, until, said)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id",
    )
    .bind(user)
    .bind(contact)
    .bind(conversation)
    .bind(group)
    .bind(&permission)
    .bind(member_of)
    .bind(until)
    .bind(&said)
    .fetch_one(&mut *tx)
    .await?;
    tx.commit().await?;
    changed(st, user, h).await;
    log::info!("pigeon access: {user} gave {} {} {}", h.kind(), h.id(), permission.unwrap_or_else(|| format!("a place in {}", member_of.unwrap_or_default())));
    grant_of(st, user, id).await
}

/// Take a grant (or a place in a group) back.
pub async fn revoke(st: &State, user: &str, id: Uuid) -> anyhow::Result<Json> {
    let g = grant_row(st, user, id).await?;
    let book = Book::load(&st.pool, user).await?;
    let names = Names::load(&st.pool, &Book { groups: vec![], grants: vec![g.clone()] }).await?;
    let view = grant_view(&g, &book, &names);
    sqlx::query("DELETE FROM db_pigeon_grants WHERE id = $1 AND user_id = $2").bind(id).bind(user).execute(&st.pool).await?;
    changed(st, user, g.holder()).await;
    log::info!("pigeon access: {user} took back {}", g.permission.clone().unwrap_or_else(|| "a place in a group".into()));
    Ok(view)
}

/// The holder's grant of this, when the id isn't known: a permission's name, or a group.
pub async fn find_grant(st: &State, user: &str, h: Holder, what: &What) -> anyhow::Result<Uuid> {
    let book = Book::load(&st.pool, user).await?;
    let found = book.own(h).find(|g| match what {
        What::Permission(name) => g.permission.as_deref().and_then(Permission::read).map(|p| p.name()) == Permission::read(&name.to_lowercase()).map(|p| p.name()),
        What::MemberOf(m) => g.member_of == Some(*m),
    });
    found.map(|g| g.id).ok_or_else(|| anyhow::anyhow!("they don't hold that"))
}

/// What a grant would let Pigeon do on its own from then on, in words for the user's tap; none:
/// nothing new happens by itself (it only asks).
pub async fn on_its_own(st: &State, user: &str, h: Holder, what: &What) -> anyhow::Result<Option<String>> {
    let book = Book::load(&st.pool, user).await?;
    let who = match h {
        Holder::Contact(c) => people::mine(st, user, c).await?.name.unwrap_or_else(|| "this person".into()),
        Holder::Conversation(_) => "this chat".into(),
        Holder::Group(g) => format!("everyone in {}", book.group_name(g)),
    };
    Ok(match what {
        What::Permission(name) => {
            let p = Permission::parse(name)?;
            let tools: Vec<String> = offer::TOOLS
                .iter()
                .filter_map(|t| p.reach(t).filter(|(_, auto)| *auto).map(|(level, _)| if t.has_levels() { format!("{} ({})", t.gives, t.levels[level].label.to_lowercase()) } else { t.gives.to_string() }))
                .collect();
            (!tools.is_empty()).then(|| format!("Let Pigeon tell {who} {} on its own", tools.join(", ")))
        }
        What::MemberOf(m) => {
            let autos: Vec<String> = book
                .effective(&[Holder::Group(*m)])
                .iter()
                .filter(|e| e.auto)
                .map(|e| if e.tool.has_levels() { format!("{} ({})", e.tool.gives, e.tool.levels[e.level].label.to_lowercase()) } else { e.tool.gives.to_string() })
                .collect();
            (!autos.is_empty()).then(|| format!("Put {who} in {}: Pigeon then tells them {} on its own", book.group_name(*m), autos.join(", ")))
        }
    })
}

/// Tell the open apps: access changed (and the chat it's about, so its screen follows).
async fn changed(st: &State, user: &str, h: Holder) {
    events::publish(&st.pool, user, "access", None).await;
    if let Holder::Conversation(c) = h {
        events::conversation(&st.pool, c).await;
    }
}

/// The grants and memberships past their end, gone (the worker, every minute).
pub async fn sweep(st: &State) -> anyhow::Result<usize> {
    let users: Vec<String> = sqlx::query_scalar("DELETE FROM db_pigeon_grants WHERE until IS NOT NULL AND until <= NOW() RETURNING user_id").fetch_all(&st.pool).await?;
    let n = users.len();
    let mut told: HashSet<&String> = HashSet::new();
    for u in &users {
        if told.insert(u) {
            events::publish(&st.pool, u, "access", None).await;
        }
    }
    let ended: Vec<String> = sqlx::query_scalar(
        "DELETE FROM db_pigeon_settings WHERE key = $1 AND value->>'until' IS NOT NULL AND (value->>'until')::timestamptz <= NOW() RETURNING user_id",
    )
    .bind(PAUSE_KEY)
    .fetch_all(&st.pool)
    .await?;
    for u in &ended {
        events::publish(&st.pool, u, "access", None).await;
    }
    Ok(n)
}

/// Grants written with a permission's old name, rewritten to its name today (the worker's start).
pub async fn renames(pool: &DbPool) -> anyhow::Result<u64> {
    let mut n = 0;
    for (old, new) in offer::WAS {
        // where the holder already has the new name, the old one just goes
        sqlx::query(
            "DELETE FROM db_pigeon_grants o WHERE o.permission = $1 AND EXISTS (SELECT 1 FROM db_pigeon_grants k WHERE k.permission = $2
                AND COALESCE(k.contact_id, k.conversation_id, k.group_id) = COALESCE(o.contact_id, o.conversation_id, o.group_id))",
        )
        .bind(old)
        .bind(new)
        .execute(pool)
        .await?;
        n += sqlx::query("UPDATE db_pigeon_grants SET permission = $2 WHERE permission = $1").bind(old).bind(new).execute(pool).await?.rows_affected();
    }
    Ok(n)
}

// ── the pause ────────────────────────────────────────────────────────────

/// "Don't tell anyone anything for a while": no tool is used for anyone while it lasts.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Pause {
    pub since: DateTime<Utc>,
    /// none: until the user ends it
    pub until: Option<DateTime<Utc>>,
}

/// The pause, while it lasts.
pub async fn paused(pool: &DbPool, user: &str) -> anyhow::Result<Option<Pause>> {
    let v: Option<Json> = sqlx::query_scalar("SELECT value FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(PAUSE_KEY).fetch_optional(pool).await?;
    Ok(v.and_then(|v| serde_json::from_value::<Pause>(v).ok()).filter(|p| p.until.is_none_or(|u| u > Utc::now())))
}

pub async fn pause(st: &State, user: &str, until: Option<DateTime<Utc>>) -> anyhow::Result<Pause> {
    if until.is_some_and(|u| u <= Utc::now()) {
        anyhow::bail!("the end is already past");
    }
    let since = paused(&st.pool, user).await?.map(|p| p.since).unwrap_or_else(Utc::now);
    let p = Pause { since, until };
    sqlx::query(
        "INSERT INTO db_pigeon_settings (user_id, key, value, updated_at) VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()",
    )
    .bind(user)
    .bind(PAUSE_KEY)
    .bind(serde_json::to_value(&p)?)
    .execute(&st.pool)
    .await?;
    events::publish(&st.pool, user, "access", None).await;
    log::info!("pigeon access: {user} paused sharing until {:?}", p.until);
    Ok(p)
}

pub async fn resume(st: &State, user: &str) -> anyhow::Result<()> {
    sqlx::query("DELETE FROM db_pigeon_settings WHERE user_id = $1 AND key = $2").bind(user).bind(PAUSE_KEY).execute(&st.pool).await?;
    events::publish(&st.pool, user, "access", None).await;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn group(n: u128, name: &str) -> Group {
        Group { id: Uuid::from_u128(n), user_id: "u".into(), name: name.into(), description: None, created_at: Utc::now(), updated_at: Utc::now() }
    }

    fn row(n: u128, h: Holder, permission: Option<&str>, member_of: Option<u128>, until: Option<DateTime<Utc>>) -> Grant {
        let (c, v, g) = match h {
            Holder::Contact(i) => (Some(i), None, None),
            Holder::Conversation(i) => (None, Some(i), None),
            Holder::Group(i) => (None, None, Some(i)),
        };
        Grant {
            id: Uuid::from_u128(1000 + n),
            user_id: "u".into(),
            contact_id: c,
            conversation_id: v,
            group_id: g,
            permission: permission.map(str::to_string),
            member_of: member_of.map(Uuid::from_u128),
            until,
            said: None,
            created_at: Utc::now(),
        }
    }

    const FRIENDS: u128 = 1;
    const FAMILY: u128 = 2;

    fn person() -> Holder {
        Holder::Contact(Uuid::from_u128(50))
    }

    fn chat() -> Holder {
        Holder::Conversation(Uuid::from_u128(60))
    }

    /// Family sits in Friends; Friends holds the city on its own, Family the exact spot after a tap.
    fn book(extra: Vec<Grant>) -> Book {
        let (friends, family) = (Holder::Group(Uuid::from_u128(FRIENDS)), Holder::Group(Uuid::from_u128(FAMILY)));
        let mut grants = vec![
            row(1, friends, Some("location.city.auto"), None, None),
            row(2, family, None, Some(FRIENDS), None),
            row(3, family, Some("location.exact.ask"), None, None),
        ];
        grants.extend(extra);
        Book { groups: vec![group(FRIENDS, "Friends"), group(FAMILY, "Family")], grants }
    }

    #[test]
    fn a_group_in_a_group_inherits_and_says_where_from() {
        let b = book(vec![row(10, person(), None, Some(FAMILY), None)]);
        let effs = b.effective(&[person()]);
        let h = held(&effs, "location");
        let auto = h.auto.unwrap();
        assert_eq!(auto.name(), "location.city.auto");
        assert_eq!(auto.from.words(), "from Friends, through Family");
        let ask = h.ask.unwrap();
        assert_eq!(ask.name(), "location.exact.ask");
        assert_eq!(ask.from.words(), "from Family");
        // nothing for a tool nobody granted
        assert!(held(&effs, "calendar").ask.is_none());
    }

    #[test]
    fn two_ways_the_higher_counts_and_the_nearest_among_equals() {
        let b = book(vec![row(10, person(), None, Some(FRIENDS), None), row(11, person(), Some("location.area.auto"), None, None)]);
        let h = held(&b.effective(&[person()]), "location");
        assert_eq!(h.auto.as_ref().unwrap().name(), "location.area.auto");
        assert_eq!(h.auto.unwrap().from, From::Direct);
        // auto includes ask: no higher ask, so ask is the auto one
        assert_eq!(h.ask.unwrap().name(), "location.area.auto");
        let b = book(vec![row(10, person(), None, Some(FRIENDS), None), row(11, person(), Some("location.city.auto"), None, None)]);
        assert_eq!(held(&b.effective(&[person()]), "location").auto.unwrap().from, From::Direct);
    }

    #[test]
    fn a_group_chat_gets_only_its_own() {
        let b = book(vec![row(10, person(), None, Some(FRIENDS), None), row(12, chat(), Some("location.country.ask"), None, None)]);
        let h = held(&b.effective(&[chat()]), "location");
        assert!(h.auto.is_none());
        assert_eq!(h.ask.as_ref().unwrap().name(), "location.country.ask");
        assert_eq!(h.ask.unwrap().from, From::Chat);
        // in their own chat, the person's count too
        assert_eq!(held(&b.effective(&[person(), chat()]), "location").auto.unwrap().name(), "location.city.auto");
    }

    #[test]
    fn a_wildcard_reaches_every_tool_and_the_end_is_the_soonest_on_the_way() {
        let soon = Utc::now() + chrono::Duration::hours(1);
        let later = Utc::now() + chrono::Duration::days(1);
        let b = Book {
            groups: vec![group(FRIENDS, "Friends")],
            grants: vec![
                row(1, Holder::Group(Uuid::from_u128(FRIENDS)), Some("*.*.ask"), None, Some(later)),
                row(2, person(), None, Some(FRIENDS), Some(soon)),
            ],
        };
        let effs = b.effective(&[person()]);
        assert_eq!(effs.len(), offer::TOOLS.len());
        assert!(effs.iter().all(|e| !e.auto && e.until == Some(soon)));
        assert_eq!(held(&effs, "location").ask.unwrap().name(), "location.exact.ask");
    }

    #[test]
    fn groups_never_loop() {
        // Friends in Family in Friends (the table's own check forbids one step; the code any)
        let b = book(vec![row(20, Holder::Group(Uuid::from_u128(FRIENDS)), None, Some(FAMILY), None), row(10, person(), None, Some(FAMILY), None)]);
        assert!(b.sits_in(Uuid::from_u128(FAMILY), Uuid::from_u128(FRIENDS)));
        assert_eq!(held(&b.effective(&[person()]), "location").auto.unwrap().name(), "location.city.auto");
    }
}

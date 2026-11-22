//! The vault over MCP (`apps::pigeon::mcp_server`, next to Pigeon's tools): notes, tasks,
//! recurring tasks, buckets, the calendar and the agenda, for an assistant outside the vault.
//! Each tool is one of Piuma's (this module's siblings), run as the caller, or — where Piuma has
//! none (a note list, the trash, versions, a folder move, one recurring task) — the REST handler
//! the web app calls, with its own permission check. Hard deletes of notes (purge, empty the
//! trash) aren't offered.
//!
//! A tool is listed and run only for a caller holding one of its scopes (`scopes`), the ones the
//! REST handlers check: `notes.read` / `notes.write`; `tasks.read` / `tasks.write` (or
//! `tasks.manage`); `calendar.read` / `calendar.write` (or `calendar.manage`); buckets with any
//! of the tasks or calendar ones; the agenda with either read, showing only what the caller may
//! read.

use actix_web::{web, HttpRequest, Responder};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use super::{agenda, buckets, calendar, notes, tasks};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::calendar::events::CalendarEventBus;
use crate::apps::notes::events::NotesEventBus;
use crate::apps::tasks::events::TasksEventBus;
use crate::db::db::DbPool;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Area {
    Notes,
    Tasks,
    Calendar,
    /// Buckets, shared by tasks and the calendar, and the agenda (read only).
    Both,
}

#[derive(Clone, Copy, PartialEq, Debug)]
enum Kind {
    Read,
    Write,
    /// A write that can't be undone.
    Delete,
}

const TASKS_READ: &[&str] = &["tasks.read", "tasks.manage"];
const TASKS_WRITE: &[&str] = &["tasks.write", "tasks.manage"];
const CALENDAR_READ: &[&str] = &["calendar.read", "calendar.manage"];
const CALENDAR_WRITE: &[&str] = &["calendar.write", "calendar.manage"];

fn area_scopes(area: Area, kind: Kind) -> &'static [&'static str] {
    match (area, kind) {
        (Area::Notes, Kind::Read) => &["notes.read"],
        (Area::Notes, _) => &["notes.write"],
        (Area::Tasks, Kind::Read) => TASKS_READ,
        (Area::Tasks, _) => TASKS_WRITE,
        (Area::Calendar, Kind::Read) => CALENDAR_READ,
        (Area::Calendar, _) => CALENDAR_WRITE,
        (Area::Both, Kind::Read) => &["tasks.read", "tasks.manage", "calendar.read", "calendar.manage"],
        (Area::Both, _) => &["tasks.write", "tasks.manage", "calendar.write", "calendar.manage"],
    }
}

/// One tool as MCP lists it.
pub struct Tool {
    pub name: &'static str,
    pub description: &'static str,
    pub schema: Json,
    area: Area,
    kind: Kind,
}

impl Tool {
    /// Any one of these lets a caller see and run it.
    pub fn scopes(&self) -> &'static [&'static str] {
        area_scopes(self.area, self.kind)
    }
    pub fn read_only(&self) -> bool {
        self.kind == Kind::Read
    }
    pub fn destructive(&self) -> bool {
        self.kind == Kind::Delete
    }
}

fn tool(name: &'static str, area: Area, kind: Kind, description: &'static str, schema: Json) -> Tool {
    Tool { name, description, schema, area, kind }
}

fn s(d: &str) -> Json {
    json!({ "type": "string", "description": d })
}

fn note_id() -> Json {
    s("The note's id (a UUID from notes_search, notes_list or notes_browse)")
}

fn tags(d: &str) -> Json {
    json!({ "type": "array", "items": { "type": "string" }, "description": d })
}

fn alerts(d: &str) -> Json {
    json!({ "type": "array", "items": { "type": "integer" }, "description": d })
}

const WHEN: &str = "RFC 3339 with its offset (2026-11-07T18:00:00+01:00, or Z for UTC)";

/// Every tool, in the order they're listed.
pub fn defs() -> Vec<Tool> {
    use Area::*;
    use Kind::*;
    vec![
        // ── Notes ──
        tool("notes_search", Notes, Read,
            "Search the user's notes by meaning and words (vector + full-text + fuzzy title), best first: id, title, folder and a snippet each. Start here for anything that may be written down, and before creating a note (the vault likely has one to add to). A brand-new note may take a few seconds to show up by meaning.",
            json!({ "type": "object", "properties": {
                "query": s("What to look for"),
                "limit": { "type": "integer", "description": "Default 8, at most 25" },
            }, "required": ["query"] })),
        tool("notes_list", Notes, Read,
            "List notes newest-updated first (id, title, folder, tags, dates; no body), optionally only those in one folder (exactly that path, not its subfolders) or with one tag. `total` counts every note.",
            json!({ "type": "object", "properties": {
                "folder": s("Only notes in exactly this folder, e.g. /projects"),
                "tag": s("Only notes with this tag (lowercase-with-hyphens)"),
                "limit": { "type": "integer", "description": "Default 50, at most 200" },
                "offset": { "type": "integer" },
            } })),
        tool("notes_get", Notes, Read,
            "One note in full: title, markdown content, folder and tags. Read a note before changing it.",
            json!({ "type": "object", "properties": { "id": note_id() }, "required": ["id"] })),
        tool("notes_folders", Notes, Read,
            "Every folder that holds a note. Folders are just a path on each note: made by using one, gone when the last note leaves.",
            json!({ "type": "object", "properties": {} })),
        tool("notes_browse", Notes, Read,
            "The notes directly in one folder and its immediate subfolders.",
            json!({ "type": "object", "properties": { "path": s("A folder path, e.g. / or /projects") }, "required": ["path"] })),
        tool("notes_find_folders", Notes, Read,
            "Folders whose path contains these words, with how many notes each holds. Use it to reuse an existing folder rather than make a near-duplicate.",
            json!({ "type": "object", "properties": { "query": s("Part of a folder's name") }, "required": ["query"] })),
        tool("notes_tags", Notes, Read,
            "Every tag used on the user's notes (a different set from the tags of tasks and events).",
            json!({ "type": "object", "properties": {} })),
        tool("notes_create", Notes, Write,
            "Create a note; returns its id. Search first: adding to an existing note beats a near-duplicate. Markdown, at most 1 MB; title at most 500 characters; a folder path starts with / (at most 255).",
            json!({ "type": "object", "properties": {
                "title": s("The note's title"),
                "content": s("The markdown body; a visible tag goes inline as #tag"),
                "folder": s("Folder path, default /. Check it with notes_find_folders or notes_folders and reuse it verbatim"),
                "tags": tags("Tags stored on the note (at most 20; made lowercase-with-hyphens)"),
            }, "required": ["title", "content"] })),
        tool("notes_update", Notes, Write,
            "Change a note: only the fields given change. `content` REPLACES the whole body (to add, notes_append; to change one passage, notes_replace_text); `folder` moves it; `tags` replaces its tags. Every save keeps a version (notes_versions).",
            json!({ "type": "object", "properties": {
                "id": note_id(),
                "title": s("New title"),
                "content": s("The whole new markdown body"),
                "folder": s("Move it to this folder (a path starting with /)"),
                "tags": tags("Its tags, all of them"),
            }, "required": ["id"] })),
        tool("notes_append", Notes, Write,
            "Add markdown at the end of a note's body, after a blank line; the rest stays as it is.",
            json!({ "type": "object", "properties": {
                "id": note_id(),
                "text": s("The markdown to add"),
            }, "required": ["id", "text"] })),
        tool("notes_replace_text", Notes, Write,
            "Replace one exact passage of a note's body, leaving the rest untouched. Copy `old_text` verbatim from notes_get; it must occur exactly once (take more around it if not). An empty `new_text` removes the passage.",
            json!({ "type": "object", "properties": {
                "id": note_id(),
                "old_text": s("The passage, exactly as it is in the note"),
                "new_text": s("What replaces it (empty: remove it)"),
            }, "required": ["id", "old_text", "new_text"] })),
        tool("notes_move_folder", Notes, Write,
            "Move (rename) a whole folder: every note in it and in its subfolders gets the new path (/banking → /finance turns /banking/cards into /finance/cards). Neither may be /.",
            json!({ "type": "object", "properties": {
                "from": s("The folder now, e.g. /banking"),
                "to": s("Its new path, e.g. /finance"),
            }, "required": ["from", "to"] })),
        tool("notes_delete", Notes, Write,
            "Move a note to the trash: a SOFT delete (it keeps its content and attachments, notes_restore brings it back). Search no longer finds it; notes_trash lists it. Confirm with the user first.",
            json!({ "type": "object", "properties": { "id": note_id() }, "required": ["id"] })),
        tool("notes_trash", Notes, Read,
            "The notes in the trash, most recently trashed first (id, title, folder, when). Their ids are what notes_restore takes.",
            json!({ "type": "object", "properties": {
                "limit": { "type": "integer", "description": "Default 50, at most 200" },
                "offset": { "type": "integer" },
            } })),
        tool("notes_restore", Notes, Write,
            "Bring a trashed note back to its folder (its id from notes_trash).",
            json!({ "type": "object", "properties": { "id": s("The trashed note's id, from notes_trash") }, "required": ["id"] })),
        tool("notes_versions", Notes, Read,
            "A note's saved versions, newest first (each save keeps one): version id, when, by what (source), title, folder and the body's length.",
            json!({ "type": "object", "properties": { "id": note_id() }, "required": ["id"] })),
        tool("notes_version_get", Notes, Read,
            "One saved version of a note in full (title, content, folder, tags).",
            json!({ "type": "object", "properties": {
                "id": note_id(),
                "version_id": { "type": "integer", "description": "From notes_versions" },
            }, "required": ["id", "version_id"] })),
        tool("notes_version_restore", Notes, Write,
            "Put a saved version back on the note (title, content, folder, tags); what it holds now becomes a version itself, so this can be undone the same way.",
            json!({ "type": "object", "properties": {
                "id": note_id(),
                "version_id": { "type": "integer", "description": "From notes_versions" },
            }, "required": ["id", "version_id"] })),
        // ── Tasks ──
        tool("tasks_list", Tasks, Read,
            "The user's one-off tasks (not recurring ones: recurring_list, agenda), open ones only unless include_done; sorted by due date, so the overdue (open, due_at past) come first. Each: id, title, done, due_at (UTC), priority (0 none … 3 high), bucket name, tags. At most 200.",
            json!({ "type": "object", "properties": {
                "include_done": { "type": "boolean", "description": "Completed tasks too" },
                "tag": s("Only tasks with this tag"),
                "bucket": s("Only tasks in this bucket, by name"),
            } })),
        tool("tasks_get", Tasks, Read,
            "One task in full: notes, due_at (UTC), priority, bucket, tags, done.",
            json!({ "type": "object", "properties": { "id": s("The task's id, from tasks_list or agenda") }, "required": ["id"] })),
        tool("tasks_create", Tasks, Write,
            "Create a one-off task; returns its id. Times: RFC 3339 with an offset (stored in UTC). Alerts need a due_at. A bucket named that doesn't exist yet is created.",
            json!({ "type": "object", "properties": {
                "title": s("What to do"),
                "notes": s("Details"),
                "due_at": s(&format!("When it's due, {WHEN}")),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s("The bucket (task group) by name; see buckets_list"),
                "tags": tags("Task tags (shared with events, lowercased, made on use)"),
                "alerts": alerts("Reminders: minutes before due_at (0 = at due_at), each a push and an alarm on the phone. Needs due_at"),
            }, "required": ["title"] })),
        tool("tasks_update", Tasks, Write,
            "Change a task: only the fields given change (a due date can't be cleared here). `tags` and `alerts` replace the task's own; bucket \"none\" takes it out of its bucket, a new name makes a bucket.",
            json!({ "type": "object", "properties": {
                "id": s("The task's id"),
                "title": s("New title"),
                "notes": s("New details"),
                "due_at": s(&format!("New due time, {WHEN}")),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s("A bucket's name, or \"none\""),
                "tags": tags("Its tags, all of them"),
                "done": { "type": "boolean" },
                "alerts": alerts("Its reminders, all of them: minutes before due_at; [] clears them"),
            }, "required": ["id"] })),
        tool("tasks_set_done", Tasks, Write,
            "Mark a task done, or open again with done false.",
            json!({ "type": "object", "properties": {
                "id": s("The task's id"),
                "done": { "type": "boolean", "description": "Default true" },
            }, "required": ["id"] })),
        tool("tasks_delete", Tasks, Delete,
            "Delete a task for good: there's no trash for tasks. Confirm with the user first; to finish one, tasks_set_done.",
            json!({ "type": "object", "properties": { "id": s("The task's id") }, "required": ["id"] })),
        // ── Recurring tasks ──
        tool("recurring_list", Tasks, Read,
            "The user's recurring tasks: templates with an RRULE, dtstart, until and active. They're never stored as occurrences until one is completed: agenda lists the occurrences in a range, with which are done.",
            json!({ "type": "object", "properties": {} })),
        tool("recurring_get", Tasks, Read,
            "One recurring task in full: rrule, dtstart, until, active, notes, priority, bucket, tags, alerts.",
            json!({ "type": "object", "properties": { "id": s("The recurring task's id") }, "required": ["id"] })),
        tool("recurring_create", Tasks, Write,
            "Create a recurring task. rrule is an iCal RRULE: FREQ DAILY, WEEKLY or MONTHLY, with INTERVAL, BYDAY (weekly), UNTIL, COUNT (e.g. FREQ=WEEKLY;BYDAY=MO,WE). A bucket named that doesn't exist yet is created.",
            json!({ "type": "object", "properties": {
                "title": s("What to do"),
                "rrule": s("e.g. FREQ=WEEKLY;BYDAY=MO"),
                "dtstart": s(&format!("The first occurrence, {WHEN}")),
                "until": s(&format!("The last day it may fall on, {WHEN}")),
                "notes": s("Details"),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s("A bucket's name"),
                "tags": tags("Task tags"),
                "alerts": alerts("Reminders: minutes before each occurrence (0 = at its time)"),
            }, "required": ["title", "rrule", "dtstart"] })),
        tool("recurring_update", Tasks, Write,
            "Change a recurring task: only the fields given change (until can't be changed here). To pause one, active false rather than deleting it.",
            json!({ "type": "object", "properties": {
                "id": s("The recurring task's id"),
                "title": s("New title"),
                "rrule": s("New RRULE"),
                "dtstart": s(&format!("New first occurrence, {WHEN}")),
                "notes": s("New details"),
                "priority": { "type": "integer" },
                "bucket": s("A bucket's name, or \"none\""),
                "tags": tags("Its tags, all of them"),
                "active": { "type": "boolean", "description": "false pauses it" },
                "alerts": alerts("Its reminders, all of them; [] clears them"),
            }, "required": ["id"] })),
        tool("recurring_complete", Tasks, Write,
            "Tick one occurrence of a recurring task done (or not, with done false) on its date (a UTC date, as agenda gives it).",
            json!({ "type": "object", "properties": {
                "recurrence_id": s("The recurring task's id"),
                "occurrence_date": s("YYYY-MM-DD, the occurrence's date from agenda"),
                "done": { "type": "boolean", "description": "Default true" },
            }, "required": ["recurrence_id", "occurrence_date"] })),
        tool("recurring_delete", Tasks, Delete,
            "Delete a recurring task and its completed occurrences for good. Confirm with the user first; to stop it, recurring_update with active false.",
            json!({ "type": "object", "properties": { "id": s("The recurring task's id") }, "required": ["id"] })),
        // ── Buckets ──
        tool("buckets_list", Both, Read,
            "The buckets (named groups of tasks, one per project or area of life) with how many tasks each holds, and every task/event tag.",
            json!({ "type": "object", "properties": {} })),
        tool("buckets_create", Both, Write,
            "Create a bucket.",
            json!({ "type": "object", "properties": {
                "name": s("e.g. Work"),
                "color": s("A hex color, e.g. #5cd0a9"),
            }, "required": ["name"] })),
        tool("buckets_update", Both, Write,
            "Rename or recolor a bucket.",
            json!({ "type": "object", "properties": {
                "id": s("The bucket's id, from buckets_list"),
                "name": s("New name"),
                "color": s("New hex color"),
            }, "required": ["id"] })),
        tool("buckets_delete", Both, Delete,
            "Delete a bucket for good. Its tasks stay, in no bucket. Confirm with the user first.",
            json!({ "type": "object", "properties": { "id": s("The bucket's id") }, "required": ["id"] })),
        // ── Calendar ──
        tool("calendar_list", Calendar, Read,
            "Calendar events overlapping a range (default: the next 30 days, at most 100): id, title, starts_at, ends_at (UTC), location. An event's rrule is stored but not expanded anywhere: a repeating event shows once, on its first date.",
            json!({ "type": "object", "properties": {
                "from": s(&format!("Range start, {WHEN}; default now")),
                "to": s(&format!("Range end, {WHEN}")),
            } })),
        tool("calendar_get", Calendar, Read,
            "One event in full: description, location, times (UTC), all_day, tags, rrule.",
            json!({ "type": "object", "properties": { "id": s("The event's id") }, "required": ["id"] })),
        tool("calendar_create", Calendar, Write,
            "Create a calendar event; returns its id. Times: RFC 3339 with an offset (stored in UTC). An rrule is kept but never expanded (the event shows once): for something that repeats, a recurring task.",
            json!({ "type": "object", "properties": {
                "title": s("The event"),
                "starts_at": s(&format!("Start, {WHEN}")),
                "ends_at": s(&format!("End, {WHEN}")),
                "all_day": { "type": "boolean" },
                "location": s("Where"),
                "description": s("Details"),
                "tags": tags("Event tags (shared with tasks)"),
                "rrule": s("iCal RRULE, stored only"),
                "alerts": alerts("Reminders: minutes before the start (0 = at the start)"),
            }, "required": ["title", "starts_at"] })),
        tool("calendar_update", Calendar, Write,
            "Change an event: only the fields given change (an end can't be cleared here). `tags` and `alerts` replace the event's own.",
            json!({ "type": "object", "properties": {
                "id": s("The event's id"),
                "title": s("New title"),
                "starts_at": s(&format!("New start, {WHEN}")),
                "ends_at": s(&format!("New end, {WHEN}")),
                "all_day": { "type": "boolean" },
                "location": s("Where"),
                "description": s("Details"),
                "tags": tags("Its tags, all of them"),
                "rrule": s("iCal RRULE, stored only"),
                "alerts": alerts("Its reminders, all of them; [] clears them"),
            }, "required": ["id"] })),
        tool("calendar_delete", Calendar, Delete,
            "Delete an event for good: there's no trash for events. Confirm with the user first.",
            json!({ "type": "object", "properties": { "id": s("The event's id") }, "required": ["id"] })),
        // ── Agenda ──
        tool("agenda", Both, Read,
            "What's on: one-off tasks due, calendar events, and recurring-task occurrences (expanded, each with done) in a range; default the next 7 days. Start here for today, this week, what's next. Times are UTC; `timezone` is the user's own (their profile), to say times in. Overdue tasks aren't in it: tasks_list.",
            json!({ "type": "object", "properties": {
                "from": s(&format!("Range start, {WHEN}; default now")),
                "to": s(&format!("Range end, {WHEN}")),
            } })),
    ]
}

/// The scopes that let a caller see and run a tool, any one of them; none: not one of these.
pub fn scopes(name: &str) -> Option<&'static [&'static str]> {
    defs().into_iter().find(|t| t.name == name).map(|t| t.scopes())
}

/// The time arguments, each RFC 3339 with its offset when given: Piuma's tools take one they
/// can't read as left out, which would quietly drop a due date.
const TIMES: &[&str] = &["due_at", "starts_at", "ends_at", "dtstart", "until", "from", "to"];

fn check_times(args: &Json) -> Result<(), String> {
    for key in TIMES {
        if let Some(v) = args.get(*key).and_then(Json::as_str).filter(|v| !v.trim().is_empty()) {
            chrono::DateTime::parse_from_rfc3339(v.trim())
                .map_err(|_| format!("`{key}`: RFC 3339 with its offset, e.g. 2026-11-07T18:00:00+01:00 or …Z, not {v}"))?;
        }
    }
    Ok(())
}

fn data<T: 'static>(req: &HttpRequest) -> Result<web::Data<T>, String> {
    req.app_data::<web::Data<T>>().cloned().ok_or_else(|| "the vault isn't ready".to_string())
}

/// A REST handler's answer as a tool's: its JSON, or its error.
async fn rest(req: &HttpRequest, answer: impl Responder) -> Result<Json, String> {
    let res = answer.respond_to(req).map_into_boxed_body();
    let status = res.status();
    let bytes = actix_web::body::to_bytes(res.into_body()).await.map_err(|_| "the answer couldn't be read".to_string())?;
    let body: Json = serde_json::from_slice(&bytes).unwrap_or(Json::Null);
    if status.is_success() {
        Ok(body)
    } else {
        Err(body.get("error").and_then(Json::as_str).map(str::to_string).unwrap_or_else(|| format!("failed ({status})")))
    }
}

fn uuid(args: &Json, key: &str) -> Result<Uuid, String> {
    super::uuid_arg(args, key)
}

fn version(args: &Json) -> Result<i64, String> {
    args.get("version_id").and_then(Json::as_i64).ok_or_else(|| "`version_id` is required (from notes_versions)".to_string())
}

fn page(args: &Json) -> (Option<i64>, Option<i64>) {
    (Some(args.get("limit").and_then(Json::as_i64).unwrap_or(50).clamp(1, 200)), args.get("offset").and_then(Json::as_i64))
}

/// Run a tool as the caller (who holds one of its scopes: the server checked).
pub async fn call(req: &HttpRequest, user: &AuthenticatedUser, name: &str, args: &Json) -> Result<Json, String> {
    use crate::apps::notes::{handlers as nh, models::{ListNotesQuery, RenameFolderRequest}, versions};
    check_times(args)?;
    let db = data::<DbPool>(req)?;
    let (pool, me) = (db.get_ref(), user.user_id.as_str());
    // The ones that are Piuma's: run as hers, then the web and the phone told, as after hers.
    let (piuma_name, out) = match name {
        "notes_search" => ("search_notes", notes::search_notes(pool, me, args).await),
        "notes_get" => {
            let id = uuid(args, "id")?;
            ("read_note", notes::read_note(pool, me, args).await.map(|mut n| {
                n["id"] = json!(id);
                n
            }))
        }
        "notes_folders" => ("list_folders", notes::list_folders(pool, me).await),
        "notes_browse" => ("browse_folder", notes::browse_folder(pool, me, args).await),
        "notes_find_folders" => ("search_folders", notes::search_folders(pool, me, args).await),
        "notes_tags" => ("list_tags", notes::list_tags(pool, me).await),
        "notes_create" => ("create_note", notes::create_note(pool, me, args).await),
        "notes_update" => ("update_note", notes::update_note(pool, me, args).await),
        "notes_append" => ("append_to_note", notes::append_to_note(pool, me, args).await),
        "notes_replace_text" => ("edit_note", notes::edit_note(pool, me, args).await),
        "notes_delete" => ("delete_note", notes::delete_note(pool, me, args).await),
        "tasks_list" => ("list_tasks", tasks::list_tasks(pool, me, args).await),
        "tasks_get" => ("get_task", tasks::get_task(pool, me, args).await),
        "tasks_create" => ("create_task", tasks::create_task(pool, me, args).await),
        "tasks_update" => ("update_task", tasks::update_task(pool, me, args).await),
        "tasks_set_done" => {
            let done = args.get("done").and_then(Json::as_bool).unwrap_or(true);
            ("update_task", tasks::update_task(pool, me, &json!({ "id": uuid(args, "id")?.to_string(), "done": done })).await)
        }
        "tasks_delete" => ("delete_task", tasks::delete_task(pool, me, args).await),
        "recurring_list" => ("list_recurring", tasks::list_recurring(pool, me).await),
        "recurring_create" => ("create_recurring", tasks::create_recurring(pool, me, args).await),
        "recurring_update" => ("update_recurring", tasks::update_recurring(pool, me, args).await),
        "recurring_complete" => ("complete_occurrence", tasks::complete_occurrence(pool, me, args).await),
        "recurring_delete" => ("delete_recurring", tasks::delete_recurring(pool, me, args).await),
        "buckets_list" => ("list_buckets", buckets::list_buckets(pool, me).await),
        "buckets_create" => ("create_bucket", buckets::create_bucket(pool, me, args).await),
        "buckets_update" => ("rename_bucket", buckets::rename_bucket(pool, me, args).await),
        "buckets_delete" => ("delete_bucket", buckets::delete_bucket(pool, me, args).await),
        "calendar_list" => ("list_events", calendar::list_events(pool, me, args).await),
        "calendar_get" => ("get_event", calendar::get_event(pool, me, args).await),
        "calendar_create" => ("create_event", calendar::create_event(pool, me, args).await),
        "calendar_update" => ("update_event", calendar::update_event(pool, me, args).await),
        "calendar_delete" => ("delete_event", calendar::delete_event(pool, me, args).await),
        "agenda" => return agenda_for(pool, user, args).await,
        // The ones Piuma hasn't: the web app's own handlers, which check the scope again.
        "notes_list" => {
            let (limit, offset) = page(args);
            let folder = args.get("folder").and_then(Json::as_str).map(str::to_string);
            let tag = args.get("tag").and_then(Json::as_str).map(str::to_string);
            let q = ListNotesQuery { search: None, folder, tag, limit, offset };
            return rest(req, nh::list_notes(user.clone(), db, web::Query(q)).await).await;
        }
        "notes_move_folder" => {
            let body = RenameFolderRequest { from: super::req_str(args, "from")?, to: super::req_str(args, "to")? };
            return rest(req, nh::rename_folder(user.clone(), web::Json(body), db, data::<NotesEventBus>(req)?).await).await;
        }
        "notes_trash" => {
            let (limit, offset) = page(args);
            let q = ListNotesQuery { search: None, folder: None, tag: None, limit, offset };
            return rest(req, nh::list_trash(user.clone(), db, web::Query(q)).await).await;
        }
        "notes_restore" => {
            let id = uuid(args, "id")?;
            return rest(req, nh::restore_note(user.clone(), web::Path::from(id), db, data::<NotesEventBus>(req)?).await).await;
        }
        "notes_versions" => {
            let id = uuid(args, "id")?;
            return rest(req, versions::list_note_versions(user.clone(), web::Path::from(id), db).await).await;
        }
        "notes_version_get" => {
            let path = web::Path::from((uuid(args, "id")?, version(args)?));
            return rest(req, versions::get_note_version(user.clone(), path, db).await).await;
        }
        "notes_version_restore" => {
            let path = web::Path::from((uuid(args, "id")?, version(args)?));
            return rest(req, versions::restore_note_version(user.clone(), path, db, data::<NotesEventBus>(req)?).await).await;
        }
        "recurring_get" => {
            let id = uuid(args, "id")?;
            return rest(req, crate::apps::tasks::handlers::get_recurring(user.clone(), web::Path::from(id), db).await).await;
        }
        other => return Err(format!("no tool {other}")),
    };
    let out = out?;
    if let (Ok(n), Ok(t), Ok(c)) = (data::<NotesEventBus>(req), data::<TasksEventBus>(req), data::<CalendarEventBus>(req)) {
        crate::apps::agents::chat::publish_tool_event(piuma_name, &out, &n, &t, &c);
    }
    Ok(out)
}

/// Piuma's agenda, with only what the caller may read, and the user's own timezone.
async fn agenda_for(pool: &DbPool, user: &AuthenticatedUser, args: &Json) -> Result<Json, String> {
    let mut out = agenda::get_agenda(pool, &user.user_id, args).await?;
    let may = |any: &[&str]| any.iter().any(|s| check_permission(user, s));
    if let Some(o) = out.as_object_mut() {
        if !may(TASKS_READ) {
            o.remove("tasks");
            o.remove("recurring");
        }
        if !may(CALENDAR_READ) {
            o.remove("events");
        }
    }
    let tz: Option<String> = sqlx::query_scalar("SELECT timezone FROM db_user_profiles WHERE user_id = $1")
        .bind(&user.user_id)
        .fetch_optional(pool)
        .await
        .map_err(|e| e.to_string())?
        .flatten();
    out["timezone"] = json!(tz);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tool_named(name: &str) -> Tool {
        defs().into_iter().find(|t| t.name == name).unwrap()
    }

    #[test]
    fn names_are_short_snake_and_unique() {
        let all = defs();
        let mut seen = std::collections::HashSet::new();
        for t in &all {
            assert!(t.name.len() <= 40, "{}", t.name);
            assert!(t.name.chars().all(|c| c.is_ascii_lowercase() || c == '_'), "{}", t.name);
            assert!(seen.insert(t.name), "{} twice", t.name);
            assert_eq!(t.schema["type"], "object", "{}", t.name);
        }
    }

    #[test]
    fn each_tool_has_the_vaults_scopes() {
        assert_eq!(scopes("notes_search"), Some(&["notes.read"][..]));
        assert_eq!(scopes("notes_trash"), Some(&["notes.read"][..]));
        assert_eq!(scopes("notes_delete"), Some(&["notes.write"][..]));
        assert_eq!(scopes("notes_version_restore"), Some(&["notes.write"][..]));
        assert_eq!(scopes("tasks_list"), Some(TASKS_READ));
        assert_eq!(scopes("recurring_get"), Some(TASKS_READ));
        assert_eq!(scopes("tasks_set_done"), Some(TASKS_WRITE));
        assert_eq!(scopes("recurring_complete"), Some(TASKS_WRITE));
        assert_eq!(scopes("calendar_list"), Some(CALENDAR_READ));
        assert_eq!(scopes("calendar_delete"), Some(CALENDAR_WRITE));
        assert_eq!(scopes("buckets_list"), Some(&["tasks.read", "tasks.manage", "calendar.read", "calendar.manage"][..]));
        assert_eq!(scopes("buckets_update"), Some(&["tasks.write", "tasks.manage", "calendar.write", "calendar.manage"][..]));
        assert!(scopes("agenda").unwrap().contains(&"calendar.read"));
        assert!(scopes("agenda").unwrap().contains(&"tasks.read"));
        assert_eq!(scopes("pigeon_inbox"), None);
        // a read is read-only and asks only a read scope; a write asks no read scope
        for t in defs() {
            let reads = t.scopes().iter().all(|s| s.ends_with(".read") || s.ends_with(".manage"));
            let writes = t.scopes().iter().all(|s| s.ends_with(".write") || s.ends_with(".manage"));
            assert_eq!(t.read_only(), reads, "{}", t.name);
            assert_eq!(!t.read_only(), writes, "{}", t.name);
        }
    }

    #[test]
    fn only_permanent_deletes_are_destructive() {
        let destructive: Vec<_> = defs().into_iter().filter(|t| t.destructive()).map(|t| t.name).collect();
        assert_eq!(destructive, ["tasks_delete", "recurring_delete", "buckets_delete", "calendar_delete"]);
        assert!(!tool_named("notes_delete").destructive());
        assert!(!tool_named("notes_delete").read_only());
    }

    #[test]
    fn times_need_their_offset() {
        assert!(check_times(&json!({ "due_at": "2026-11-07T18:00:00+01:00", "to": "2026-11-08T00:00:00Z" })).is_ok());
        assert!(check_times(&json!({ "title": "x", "due_at": "" })).is_ok());
        assert!(check_times(&json!({ "due_at": "2026-11-07" })).is_err());
        assert!(check_times(&json!({ "starts_at": "2026-11-07 18:00" })).is_err());
        assert!(check_times(&json!({ "from": "tomorrow" })).is_err());
    }
}

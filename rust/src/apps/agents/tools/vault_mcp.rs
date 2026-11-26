//! The vault over MCP (`apps::pigeon::mcp_server`, next to Pigeon's tools): notes, tasks,
//! recurring tasks, buckets, the calendar, the agenda and the recorder's sessions, for an
//! assistant outside the vault.
//! Each tool is one of Piuma's (this module's siblings), run as the caller, or — where Piuma has
//! none (a note list, a search within a folder or tag, the trash, versions, a folder move, one
//! recurring task) or hers can't do it (an update that clears a field) — the REST handler the web
//! app calls, with its own permission check. Hard deletes of notes (purge, empty the trash)
//! aren't offered.
//!
//! The arguments' one convention: a field left out (or null) is kept; a field is cleared only by
//! saying so (`clear_due`, `clear_end`, `clear_until`; bucket "none"). A bucket is named, and
//! must exist: an unknown name is an error naming the ones there are (Piuma's own tools make
//! one; here that's `buckets_create`).
//!
//! A tool is listed and run only for a caller holding one of its scopes (`scopes`), the ones the
//! REST handlers check: `notes.read` / `notes.write`; `tasks.read` / `tasks.write` (or
//! `tasks.manage`); `calendar.read` / `calendar.write` (or `calendar.manage`); buckets with any
//! of the tasks or calendar ones; the agenda with either read, showing only what the caller may
//! read; `recorder.read` / `recorder.write` for the recorder (its REST handlers, run as they are:
//! a recording is made in the web app or the phone, never here).

use actix_web::{web, HttpRequest, Responder};
use serde_json::{json, Value as Json};
use uuid::Uuid;

use super::{agenda, buckets, calendar, notes, tasks};
use crate::apps::auth::middleware::check_permission;
use crate::apps::auth::models::AuthenticatedUser;
use crate::apps::calendar::events::CalendarEventBus;
use crate::apps::calendar::models::UpdateEventRequest;
use crate::apps::notes::events::NotesEventBus;
use crate::apps::tasks::events::TasksEventBus;
use crate::apps::tasks::models::{UpdateRecurringTaskRequest, UpdateTaskRequest};
use crate::db::db::DbPool;

#[derive(Clone, Copy, PartialEq, Debug)]
enum Area {
    Notes,
    Tasks,
    Calendar,
    /// Buckets, shared by tasks and the calendar, and the agenda (read only).
    Both,
    Recorder,
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
        (Area::Recorder, Kind::Read) => &["recorder.read"],
        (Area::Recorder, _) => &["recorder.write"],
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

fn clear(d: &str) -> Json {
    json!({ "type": "boolean", "description": d })
}

fn session_id() -> Json {
    s("The recording's id (a UUID from recorder_sessions)")
}

const BUCKET: &str = "The bucket (task group) by name, one of buckets_list's (an unknown name is an error: buckets_create makes one)";

/// Every tool, in the order they're listed.
pub fn defs() -> Vec<Tool> {
    use Area::*;
    use Kind::*;
    vec![
        // ── Notes ──
        tool("notes_search", Notes, Read,
            "Search the user's notes by meaning and words (vector + full-text + fuzzy title), best first: id, title, folder and a snippet each, optionally only in one folder or with one tag. Start here for anything that may be written down, and before creating a note (the vault likely has one to add to). A brand-new note may take a few seconds to show up by meaning.",
            json!({ "type": "object", "properties": {
                "query": s("What to look for"),
                "folder": s("Only notes in exactly this folder (not its subfolders), e.g. /projects"),
                "tag": s("Only notes with this tag (lowercase-with-hyphens)"),
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
            "The user's one-off tasks (not recurring ones: recurring_list, agenda), open ones only unless include_done; sorted by due date, so the overdue (open, due_at past) come first. Each: id, title, done, due_at (UTC), priority (0 none … 3 high), bucket name, tags. The filters combine; at most 200.",
            json!({ "type": "object", "properties": {
                "include_done": { "type": "boolean", "description": "Completed tasks too" },
                "overdue": { "type": "boolean", "description": "Only the late ones: open, due before now" },
                "due_before": s(&format!("Only tasks due before this, {WHEN}")),
                "due_after": s(&format!("Only tasks due at or after this, {WHEN}")),
                "tag": s("Only tasks with this tag"),
                "bucket": s("Only tasks in this bucket, by name (an unknown one is an error); \"none\": only those in no bucket"),
            } })),
        tool("tasks_get", Tasks, Read,
            "One task in full: notes, due_at (UTC), priority, bucket, tags, done.",
            json!({ "type": "object", "properties": { "id": s("The task's id, from tasks_list or agenda") }, "required": ["id"] })),
        tool("tasks_create", Tasks, Write,
            "Create a one-off task; returns its id. Times: RFC 3339 with an offset (stored in UTC). Alerts need a due_at. The bucket must exist (buckets_list; buckets_create makes one).",
            json!({ "type": "object", "properties": {
                "title": s("What to do"),
                "notes": s("Details"),
                "due_at": s(&format!("When it's due, {WHEN}")),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s(BUCKET),
                "tags": tags("Task tags (shared with events, lowercased, made on use)"),
                "alerts": alerts("Reminders: minutes before due_at (0 = at due_at), each a push and an alarm on the phone. Needs due_at"),
            }, "required": ["title"] })),
        tool("tasks_update", Tasks, Write,
            "Change a task: only the fields given change (left out or null: kept). clear_due removes the due date (its alerts must go too: alerts []). `tags` and `alerts` replace the task's own; bucket \"none\" takes it out of its bucket, another name must be an existing bucket. Returns the task.",
            json!({ "type": "object", "properties": {
                "id": s("The task's id"),
                "title": s("New title"),
                "notes": s("New details"),
                "due_at": s(&format!("New due time, {WHEN}")),
                "clear_due": clear("true: the task has no due date any more (not with due_at)"),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s("An existing bucket's name, or \"none\" for no bucket"),
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
            "Create a recurring task. rrule is an iCal RRULE: FREQ DAILY, WEEKLY or MONTHLY, with INTERVAL, BYDAY (weekly), UNTIL, COUNT (e.g. FREQ=WEEKLY;BYDAY=MO,WE). The bucket must exist (buckets_list; buckets_create makes one).",
            json!({ "type": "object", "properties": {
                "title": s("What to do"),
                "rrule": s("e.g. FREQ=WEEKLY;BYDAY=MO"),
                "dtstart": s(&format!("The first occurrence, {WHEN}")),
                "until": s(&format!("The last day it may fall on, {WHEN}")),
                "notes": s("Details"),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s(BUCKET),
                "tags": tags("Task tags"),
                "alerts": alerts("Reminders: minutes before each occurrence (0 = at its time)"),
            }, "required": ["title", "rrule", "dtstart"] })),
        tool("recurring_update", Tasks, Write,
            "Change a recurring task: only the fields given change (left out or null: kept). `until` sets its last day, clear_until lets it run on. To pause one, active false rather than deleting it. Returns the recurring task.",
            json!({ "type": "object", "properties": {
                "id": s("The recurring task's id"),
                "title": s("New title"),
                "rrule": s("New RRULE"),
                "dtstart": s(&format!("New first occurrence, {WHEN}")),
                "until": s(&format!("The last day it may fall on, {WHEN}")),
                "clear_until": clear("true: no last day any more, it runs on (not with until)"),
                "notes": s("New details"),
                "priority": { "type": "integer", "description": "0 none, 1 low, 2 medium, 3 high" },
                "bucket": s("An existing bucket's name, or \"none\" for no bucket"),
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
            "Change an event: only the fields given change (left out or null: kept). clear_end removes its end. `tags` and `alerts` replace the event's own. Returns the event.",
            json!({ "type": "object", "properties": {
                "id": s("The event's id"),
                "title": s("New title"),
                "starts_at": s(&format!("New start, {WHEN}")),
                "ends_at": s(&format!("New end, {WHEN}")),
                "clear_end": clear("true: the event has no end any more (not with ends_at)"),
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
        // ── Recorder ──
        tool("recorder_sessions", Recorder, Read,
            "The user's recordings (meetings, calls, voice notes), newest first, at most 200: id, title, status (recording, ready: saved and not summarised, summarising, done, failed), duration_secs, word_count, the start of what was said (preview), the summary note (final_note_id, a note's id: notes_get), error, created_at (UTC). What was said in full: recorder_transcript.",
            json!({ "type": "object", "properties": {
                "query": s("Only the recordings whose title or preview holds these words"),
            } })),
        tool("recorder_get", Recorder, Read,
            "One recording in full: its fields as recorder_sessions lists them, and running_summary, the summary kept while it was recording.",
            json!({ "type": "object", "properties": { "id": session_id() }, "required": ["id"] })),
        tool("recorder_transcript", Recorder, Read,
            "What was said in a recording, as lines `[h:mm:ss] S1: …` (S1, S2…: the speakers told apart, not named), paged: pass next_offset back as offset until it's null. ready false: nothing saved yet (still recording).",
            json!({ "type": "object", "properties": {
                "id": session_id(),
                "offset": { "type": "integer", "description": "Characters to skip, from next_offset (default 0)" },
                "max_chars": { "type": "integer", "description": "At most this many characters, 1000–50000 (default 20000)" },
            }, "required": ["id"] })),
        tool("recorder_usage", Recorder, Read,
            "Transcription used per month and provider (sessions, seconds), and the providers' free hours a month.",
            json!({ "type": "object", "properties": {} })),
        tool("recorder_rename", Recorder, Write,
            "Rename a recording.",
            json!({ "type": "object", "properties": { "id": session_id(), "title": s("The new title") }, "required": ["id", "title"] })),
        tool("recorder_summarise", Recorder, Write,
            "Summarise a saved recording again (a minute or more for a long one): its summary note is written anew, or made if it has none. Returns the note's id.",
            json!({ "type": "object", "properties": { "id": session_id() }, "required": ["id"] })),
        tool("recorder_stop", Recorder, Write,
            "Stop a recording that is recording now: it is saved, and summarised as the user set.",
            json!({ "type": "object", "properties": { "id": session_id() }, "required": ["id"] })),
        tool("recorder_append", Recorder, Delete,
            "Join two recordings into one: `id`'s transcript goes on after `target_id`'s, then `id` is deleted for good (its transcript; its summary note to the trash) and the joined one is summarised again. Confirm with the user first.",
            json!({ "type": "object", "properties": {
                "id": s("The recording that goes on the end, and is then deleted"),
                "target_id": s("The recording it joins, which stays"),
            }, "required": ["id", "target_id"] })),
        tool("recorder_delete", Recorder, Delete,
            "Delete a recording for good: the session and its transcript (its summary note goes to the trash). Confirm with the user first.",
            json!({ "type": "object", "properties": { "id": session_id() }, "required": ["id"] })),
    ]
}

/// The scopes that let a caller see and run a tool, any one of them; none: not one of these.
pub fn scopes(name: &str) -> Option<&'static [&'static str]> {
    defs().into_iter().find(|t| t.name == name).map(|t| t.scopes())
}

/// The time arguments, each RFC 3339 with its offset when given: Piuma's tools take one they
/// can't read as left out, which would quietly drop a due date.
const TIMES: &[&str] = &["due_at", "starts_at", "ends_at", "dtstart", "until", "from", "to", "due_before", "due_after"];

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

/// A time argument: left out, null or empty is none; anything else RFC 3339 with its offset.
fn time(args: &Json, key: &str) -> Result<Option<chrono::DateTime<chrono::Utc>>, String> {
    match args.get(key) {
        None | Some(Json::Null) => Ok(None),
        Some(Json::String(v)) if v.trim().is_empty() => Ok(None),
        Some(Json::String(v)) => chrono::DateTime::parse_from_rfc3339(v.trim())
            .map(|t| Some(t.with_timezone(&chrono::Utc)))
            .map_err(|_| format!("`{key}`: RFC 3339 with its offset, e.g. 2026-11-07T18:00:00+01:00 or …Z, not {v}")),
        Some(other) => Err(format!("`{key}`: a time in RFC 3339, not {other}")),
    }
}

/// A time an update can clear, as the REST bodies take it: `key` sets it, `clear` (true) clears
/// it (Some(None)), neither keeps it (None).
fn clearable(args: &Json, key: &str, clear: &str) -> Result<Option<Option<chrono::DateTime<chrono::Utc>>>, String> {
    let set = time(args, key)?;
    let clearing = args.get(clear).and_then(Json::as_bool).unwrap_or(false);
    match (set, clearing) {
        (Some(_), true) => Err(format!("`{key}` or `{clear}`, not both")),
        (Some(t), false) => Ok(Some(Some(t))),
        (None, true) => Ok(Some(None)),
        (None, false) => Ok(None),
    }
}

/// What a `bucket` argument asks.
#[derive(Debug, PartialEq)]
enum Bucket {
    /// Left out (or null): as it is.
    Keep,
    /// "none": no bucket.
    NoBucket,
    /// An existing bucket, by name.
    Named(String),
}

fn bucket_arg(args: &Json) -> Result<Bucket, String> {
    match args.get("bucket") {
        None | Some(Json::Null) => Ok(Bucket::Keep),
        Some(Json::String(n)) if n.trim().eq_ignore_ascii_case("none") => Ok(Bucket::NoBucket),
        Some(Json::String(n)) if !n.trim().is_empty() => Ok(Bucket::Named(n.trim().to_string())),
        Some(_) => Err("`bucket`: an existing bucket's name (buckets_list), or \"none\"".into()),
    }
}

/// The user's bucket of that name (any case), or an error naming the ones there are: no tool
/// here makes one on the way (buckets_create does).
fn pick_bucket(name: &str, buckets: &[(Uuid, String)]) -> Result<(Uuid, String), String> {
    let want = name.to_lowercase();
    if let Some(b) = buckets.iter().find(|(_, n)| n.to_lowercase() == want) {
        return Ok(b.clone());
    }
    let there = if buckets.is_empty() {
        "there are none yet".to_string()
    } else {
        format!("there are: {}", buckets.iter().map(|(_, n)| n.as_str()).collect::<Vec<_>>().join(", "))
    };
    Err(format!("no bucket named \"{name}\" ({there}); buckets_create makes one"))
}

async fn find_bucket(pool: &DbPool, me: &str, name: &str) -> Result<(Uuid, String), String> {
    let buckets: Vec<(Uuid, String)> = sqlx::query_as("SELECT id, name FROM db_buckets WHERE user_id = $1 ORDER BY sort_order, lower(name)")
        .bind(me)
        .fetch_all(pool)
        .await
        .map_err(|e| e.to_string())?;
    pick_bucket(name, &buckets)
}

/// The bucket an update sets, as the REST bodies take it: None keeps it, Some(None) clears it.
async fn bucket_id(pool: &DbPool, me: &str, args: &Json) -> Result<Option<Option<Uuid>>, String> {
    Ok(match bucket_arg(args)? {
        Bucket::Keep => None,
        Bucket::NoBucket => Some(None),
        Bucket::Named(n) => Some(Some(find_bucket(pool, me, &n).await?.0)),
    })
}

/// The arguments for one of Piuma's tools that take a bucket by name, with the name checked
/// first: hers makes a bucket it doesn't find. "none" (no bucket) is left out; a bucket keeps
/// its own spelling.
async fn existing_bucket(pool: &DbPool, me: &str, args: &Json) -> Result<Json, String> {
    let mut args = args.clone();
    match bucket_arg(&args)? {
        Bucket::Keep => {}
        Bucket::NoBucket => {
            if let Some(o) = args.as_object_mut() {
                o.remove("bucket");
            }
        }
        Bucket::Named(n) => args["bucket"] = json!(find_bucket(pool, me, &n).await?.1),
    }
    Ok(args)
}

/// tasks_list's arguments for Piuma's list_tasks: the bucket checked, "none" as `no_bucket`.
async fn task_filters(pool: &DbPool, me: &str, args: &Json) -> Result<Json, String> {
    let mut out = args.clone();
    if bucket_arg(args)? == Bucket::NoBucket {
        if let Some(o) = out.as_object_mut() {
            o.remove("bucket");
            o.insert("no_bucket".into(), json!(true));
        }
        return Ok(out);
    }
    existing_bucket(pool, me, args).await
}

/// tasks_update as the REST body (its bucket set apart, by `bucket_id`).
fn task_patch(args: &Json) -> Result<UpdateTaskRequest, String> {
    use super::{opt_bool, opt_i16, opt_str_array, opt_string, parse_alerts};
    Ok(UpdateTaskRequest {
        title: opt_string(args, "title"),
        notes: opt_string(args, "notes").map(Some),
        due_at: clearable(args, "due_at", "clear_due")?,
        priority: opt_i16(args, "priority"),
        bucket_id: None,
        tags: opt_str_array(args, "tags"),
        rank: None,
        done: opt_bool(args, "done"),
        alerts: parse_alerts(args, "alerts"),
    })
}

/// recurring_update as the REST body (its bucket set apart).
fn recurring_patch(args: &Json) -> Result<UpdateRecurringTaskRequest, String> {
    use super::{opt_bool, opt_i16, opt_str_array, opt_string, parse_alerts};
    Ok(UpdateRecurringTaskRequest {
        title: opt_string(args, "title"),
        notes: opt_string(args, "notes").map(Some),
        priority: opt_i16(args, "priority"),
        bucket_id: None,
        tags: opt_str_array(args, "tags"),
        rrule: opt_string(args, "rrule"),
        dtstart: time(args, "dtstart")?,
        until: clearable(args, "until", "clear_until")?,
        active: opt_bool(args, "active"),
        alerts: parse_alerts(args, "alerts"),
    })
}

/// calendar_update as the REST body.
fn event_patch(args: &Json) -> Result<UpdateEventRequest, String> {
    use super::{opt_bool, opt_str_array, opt_string, parse_alerts};
    Ok(UpdateEventRequest {
        title: opt_string(args, "title"),
        description: opt_string(args, "description"),
        location: opt_string(args, "location"),
        starts_at: time(args, "starts_at")?,
        ends_at: clearable(args, "ends_at", "clear_end")?,
        all_day: opt_bool(args, "all_day"),
        color: None,
        tags: opt_str_array(args, "tags"),
        rrule: opt_string(args, "rrule").map(Some),
        alerts: parse_alerts(args, "alerts"),
    })
}

/// A search hit's highlighted words (the REST search's `headline`, HTML) as plain text.
fn plain(headline: &str) -> String {
    headline
        .replace("<b>", "")
        .replace("</b>", "")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&#x27;", "'")
        .replace("&amp;", "&")
}

/// The REST search's answer as notes_search gives one: id, title, folder, tags and a snippet.
fn search_hits(out: &Json) -> Json {
    let results: Vec<Json> = out["data"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|n| {
            json!({
                "id": n["id"], "title": n["title"], "folder": n["folder"].as_str().unwrap_or("/"), "tags": n["tags"],
                "snippet": plain(n["headline"].as_str().unwrap_or_default()),
            })
        })
        .collect();
    json!({ "count": results.len(), "results": results })
}

/// A recording as listed: the row without what's only the vault's (its owner, the transcript's
/// storage key) or long (the running summary: recorder_get).
fn session_row(row: &Json) -> Json {
    let mut row = row.clone();
    if let Some(o) = row.as_object_mut() {
        for key in ["user_id", "transcript_storage_key", "running_summary"] {
            o.remove(key);
        }
    }
    row
}

fn clock(secs: f64) -> String {
    let t = secs.max(0.0) as u64;
    format!("{}:{:02}:{:02}", t / 3600, t / 60 % 60, t % 60)
}

/// A transcript as lines, one per turn (a speaker's consecutive segments joined), then one page
/// of it: `offset` and `max_chars` in characters, cut at a line's end where one fits.
fn transcript_page(out: &Json, offset: usize, max_chars: usize) -> Json {
    let mut lines: Vec<String> = Vec::new();
    let mut last: Option<String> = None;
    for seg in out.get("segments").and_then(Json::as_array).into_iter().flatten() {
        if seg.get("is_final").and_then(Json::as_bool) == Some(false) {
            continue;
        }
        let text = seg.get("text").and_then(Json::as_str).unwrap_or("").trim();
        if text.is_empty() {
            continue;
        }
        let speaker = seg.get("speaker").and_then(Json::as_str).map(str::to_string);
        match lines.last_mut() {
            Some(line) if speaker == last => {
                line.push(' ');
                line.push_str(text);
            }
            _ => {
                let at = clock(seg.get("t").and_then(Json::as_f64).unwrap_or(0.0));
                lines.push(match &speaker {
                    Some(who) => format!("[{at}] {who}: {text}"),
                    None => format!("[{at}] {text}"),
                });
            }
        }
        last = speaker;
    }
    let all: Vec<char> = lines.join("\n").chars().collect();
    let start = offset.min(all.len());
    let mut end = (start + max_chars).min(all.len());
    if end < all.len() {
        if let Some(nl) = all[start..end].iter().rposition(|c| *c == '\n').filter(|nl| *nl > 0) {
            end = start + nl + 1;
        }
    }
    json!({
        "ready": out.get("ready").and_then(Json::as_bool).unwrap_or(false),
        "total_chars": all.len(),
        "offset": start,
        "next_offset": if end < all.len() { json!(end) } else { Json::Null },
        "text": all[start..end].iter().collect::<String>(),
    })
}

fn filter(args: &Json, key: &str) -> Option<String> {
    args.get(key).and_then(Json::as_str).map(str::trim).filter(|v| !v.is_empty()).map(str::to_string)
}

/// Run a tool as the caller (who holds one of its scopes: the server checked).
pub async fn call(req: &HttpRequest, user: &AuthenticatedUser, name: &str, args: &Json) -> Result<Json, String> {
    use crate::apps::notes::{handlers as nh, models::{ListNotesQuery, RenameFolderRequest}, versions};
    use crate::apps::recorder::{handlers as rh, models::{AppendRequest, TitleRequest}, session::SessionRegistry};
    use crate::apps::{calendar::handlers as ch, tasks::handlers as th};
    check_times(args)?;
    let db = data::<DbPool>(req)?;
    let (pool, me) = (db.get_ref(), user.user_id.as_str());
    // The ones that are Piuma's: run as hers, then the web and the phone told, as after hers.
    let (piuma_name, out) = match name {
        "notes_search" if filter(args, "folder").is_none() && filter(args, "tag").is_none() => {
            ("search_notes", notes::search_notes(pool, me, args).await)
        }
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
        "tasks_list" => ("list_tasks", tasks::list_tasks(pool, me, &task_filters(pool, me, args).await?).await),
        "tasks_get" => ("get_task", tasks::get_task(pool, me, args).await),
        "tasks_create" => ("create_task", tasks::create_task(pool, me, &existing_bucket(pool, me, args).await?).await),
        "tasks_set_done" => {
            let done = args.get("done").and_then(Json::as_bool).unwrap_or(true);
            ("update_task", tasks::update_task(pool, me, &json!({ "id": uuid(args, "id")?.to_string(), "done": done })).await)
        }
        "tasks_delete" => ("delete_task", tasks::delete_task(pool, me, args).await),
        "recurring_list" => ("list_recurring", tasks::list_recurring(pool, me).await),
        "recurring_create" => ("create_recurring", tasks::create_recurring(pool, me, &existing_bucket(pool, me, args).await?).await),
        "recurring_complete" => ("complete_occurrence", tasks::complete_occurrence(pool, me, args).await),
        "recurring_delete" => ("delete_recurring", tasks::delete_recurring(pool, me, args).await),
        "buckets_list" => ("list_buckets", buckets::list_buckets(pool, me).await),
        "buckets_create" => ("create_bucket", buckets::create_bucket(pool, me, args).await),
        "buckets_update" => ("rename_bucket", buckets::rename_bucket(pool, me, args).await),
        "buckets_delete" => ("delete_bucket", buckets::delete_bucket(pool, me, args).await),
        "calendar_list" => ("list_events", calendar::list_events(pool, me, args).await),
        "calendar_get" => ("get_event", calendar::get_event(pool, me, args).await),
        "calendar_create" => ("create_event", calendar::create_event(pool, me, args).await),
        "calendar_delete" => ("delete_event", calendar::delete_event(pool, me, args).await),
        "agenda" => return agenda_for(pool, user, args).await,
        // The ones Piuma hasn't, or can't do: the web app's own handlers, which check the scope
        // again and tell the web and the phone themselves.
        "notes_search" => {
            let limit = args.get("limit").and_then(Json::as_i64).unwrap_or(8).clamp(1, 25);
            let q = ListNotesQuery {
                search: Some(super::req_str(args, "query")?),
                folder: filter(args, "folder"),
                tag: filter(args, "tag"),
                limit: Some(limit),
                offset: None,
            };
            return rest(req, nh::list_notes(user.clone(), db, web::Query(q)).await).await.map(|out| search_hits(&out));
        }
        "tasks_update" => {
            let id = uuid(args, "id")?;
            let mut body = task_patch(args)?;
            body.bucket_id = bucket_id(pool, me, args).await?;
            return rest(req, th::update_task(user.clone(), web::Path::from(id), web::Json(body), db, data::<TasksEventBus>(req)?).await).await;
        }
        "recurring_update" => {
            let id = uuid(args, "id")?;
            let mut body = recurring_patch(args)?;
            body.bucket_id = bucket_id(pool, me, args).await?;
            return rest(req, th::update_recurring(user.clone(), web::Path::from(id), web::Json(body), db, data::<TasksEventBus>(req)?).await).await;
        }
        "calendar_update" => {
            let id = uuid(args, "id")?;
            let body = event_patch(args)?;
            return rest(req, ch::update_event(user.clone(), web::Path::from(id), web::Json(body), db, data::<CalendarEventBus>(req)?).await).await;
        }
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
            return rest(req, th::get_recurring(user.clone(), web::Path::from(id), db).await).await;
        }
        "recorder_sessions" => {
            let out = rest(req, rh::list_sessions(user.clone(), db).await).await?;
            let words = filter(args, "query").map(|q| q.to_lowercase());
            let rows: Vec<Json> = out
                .as_array()
                .into_iter()
                .flatten()
                .filter(|row| {
                    words.as_deref().is_none_or(|q| {
                        ["title", "preview"].iter().any(|k| row.get(*k).and_then(Json::as_str).is_some_and(|v| v.to_lowercase().contains(q)))
                    })
                })
                .map(session_row)
                .collect();
            return Ok(json!({ "count": rows.len(), "sessions": rows }));
        }
        "recorder_get" => {
            let id = uuid(args, "id")?;
            let mut out = rest(req, rh::get_session(user.clone(), db, web::Path::from(id)).await).await?;
            if let Some(o) = out.as_object_mut() {
                o.remove("user_id");
                o.remove("transcript_storage_key");
            }
            return Ok(out);
        }
        "recorder_transcript" => {
            let id = uuid(args, "id")?;
            let offset = args.get("offset").and_then(Json::as_u64).unwrap_or(0) as usize;
            let max_chars = args.get("max_chars").and_then(Json::as_u64).unwrap_or(20_000).clamp(1_000, 50_000) as usize;
            let out = rest(req, rh::get_transcript(user.clone(), db, web::Path::from(id)).await).await?;
            return Ok(transcript_page(&out, offset, max_chars));
        }
        "recorder_usage" => return rest(req, rh::usage(user.clone(), db).await).await,
        "recorder_rename" => {
            let id = uuid(args, "id")?;
            let body = TitleRequest { title: super::req_str(args, "title")? };
            return rest(req, rh::set_title(user.clone(), db, web::Path::from(id), web::Json(body)).await).await;
        }
        "recorder_summarise" => {
            let id = uuid(args, "id")?;
            return rest(req, rh::summarise_session(user.clone(), db, web::Path::from(id)).await).await;
        }
        "recorder_stop" => {
            let id = uuid(args, "id")?;
            return rest(req, rh::stop_session(user.clone(), db, data::<SessionRegistry>(req)?, web::Path::from(id)).await).await;
        }
        "recorder_append" => {
            let id = uuid(args, "id")?;
            let body = AppendRequest { target_id: uuid(args, "target_id")? };
            let (registry, notes) = (data::<SessionRegistry>(req)?, data::<NotesEventBus>(req)?);
            return rest(req, rh::append_session(user.clone(), db, registry, notes, web::Path::from(id), web::Json(body)).await).await;
        }
        "recorder_delete" => {
            let id = uuid(args, "id")?;
            let (registry, notes) = (data::<SessionRegistry>(req)?, data::<NotesEventBus>(req)?);
            return rest(req, rh::delete_session(user.clone(), db, registry, notes, web::Path::from(id)).await).await;
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
        assert_eq!(scopes("recorder_transcript"), Some(&["recorder.read"][..]));
        assert_eq!(scopes("recorder_summarise"), Some(&["recorder.write"][..]));
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
        assert_eq!(destructive, ["tasks_delete", "recurring_delete", "buckets_delete", "calendar_delete", "recorder_append", "recorder_delete"]);
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

    #[test]
    fn times_need_their_offset_in_the_filters_too() {
        assert!(check_times(&json!({ "due_before": "2026-11-07T00:00:00Z", "due_after": "2026-11-01T00:00:00+07:00" })).is_ok());
        assert!(check_times(&json!({ "due_before": "2026-11-07" })).is_err());
    }

    #[test]
    fn a_field_is_cleared_only_when_told() {
        let at = chrono::DateTime::parse_from_rfc3339("2026-11-07T18:00:00+01:00").unwrap().with_timezone(&chrono::Utc);
        assert_eq!(clearable(&json!({ "due_at": "2026-11-07T18:00:00+01:00" }), "due_at", "clear_due"), Ok(Some(Some(at))));
        assert_eq!(clearable(&json!({ "clear_due": true }), "due_at", "clear_due"), Ok(Some(None)));
        // left out, null, empty, or clear false: kept
        assert_eq!(clearable(&json!({}), "due_at", "clear_due"), Ok(None));
        assert_eq!(clearable(&json!({ "due_at": null }), "due_at", "clear_due"), Ok(None));
        assert_eq!(clearable(&json!({ "due_at": " " }), "due_at", "clear_due"), Ok(None));
        assert_eq!(clearable(&json!({ "clear_due": false }), "due_at", "clear_due"), Ok(None));
        assert!(clearable(&json!({ "due_at": "2026-11-07T18:00:00Z", "clear_due": true }), "due_at", "clear_due").unwrap_err().contains("not both"));
        assert!(clearable(&json!({ "due_at": "tomorrow" }), "due_at", "clear_due").is_err());
        assert!(clearable(&json!({ "due_at": 5 }), "due_at", "clear_due").is_err());
    }

    #[test]
    fn the_updates_as_the_rest_bodies() {
        let t = task_patch(&json!({ "id": "x", "title": "Call", "clear_due": true, "alerts": [], "done": true })).unwrap();
        assert_eq!((t.title.as_deref(), t.due_at, t.done), (Some("Call"), Some(None), Some(true)));
        assert_eq!(t.alerts, Some(json!([])));
        assert!(t.notes.is_none() && t.priority.is_none() && t.tags.is_none() && t.bucket_id.is_none());
        let t = task_patch(&json!({ "notes": "n", "alerts": [10] })).unwrap();
        assert_eq!(t.notes, Some(Some("n".into())));
        assert_eq!(t.due_at, None);
        assert_eq!(t.alerts, Some(json!([{ "offset_minutes": 10 }])));
        assert!(task_patch(&json!({ "due_at": "2026-11-07T18:00:00Z", "clear_due": true })).is_err());

        let r = recurring_patch(&json!({ "until": "2026-12-31T23:59:59Z" })).unwrap();
        assert!(matches!(r.until, Some(Some(_))));
        assert_eq!(recurring_patch(&json!({ "clear_until": true })).unwrap().until, Some(None));
        assert_eq!(recurring_patch(&json!({ "active": false })).unwrap().until, None);
        assert!(recurring_patch(&json!({ "dtstart": "2026-11-07" })).is_err());

        let e = event_patch(&json!({ "clear_end": true, "location": "Home" })).unwrap();
        assert_eq!((e.ends_at, e.location.as_deref(), e.starts_at), (Some(None), Some("Home"), None));
        assert!(matches!(event_patch(&json!({ "ends_at": "2026-11-07T19:00:00Z" })).unwrap().ends_at, Some(Some(_))));
        assert!(event_patch(&json!({ "ends_at": "2026-11-07T19:00:00Z", "clear_end": true })).is_err());
    }

    #[test]
    fn a_bucket_is_one_that_exists() {
        assert_eq!(bucket_arg(&json!({})), Ok(Bucket::Keep));
        assert_eq!(bucket_arg(&json!({ "bucket": null })), Ok(Bucket::Keep));
        assert_eq!(bucket_arg(&json!({ "bucket": " None " })), Ok(Bucket::NoBucket));
        assert_eq!(bucket_arg(&json!({ "bucket": " Work " })), Ok(Bucket::Named("Work".into())));
        assert!(bucket_arg(&json!({ "bucket": "" })).is_err());
        assert!(bucket_arg(&json!({ "bucket": 3 })).is_err());

        let (work, home) = (Uuid::new_v4(), Uuid::new_v4());
        let there = [(work, "Work".to_string()), (home, "Casa Città".to_string())];
        assert_eq!(pick_bucket("work", &there), Ok((work, "Work".into())));
        assert_eq!(pick_bucket("CASA CITTÀ", &there).unwrap().0, home);
        let err = pick_bucket("Gym", &there).unwrap_err();
        assert!(err.contains("\"Gym\"") && err.contains("Work, Casa Città") && err.contains("buckets_create"), "{err}");
        assert!(pick_bucket("Gym", &[]).unwrap_err().contains("none yet"));
    }

    #[test]
    fn the_new_arguments_are_in_the_schemas() {
        let props = |n: &str| tool_named(n).schema["properties"].clone();
        for (tool, arg) in [
            ("tasks_list", "overdue"), ("tasks_list", "due_before"), ("tasks_list", "due_after"), ("tasks_list", "bucket"), ("tasks_list", "tag"),
            ("tasks_update", "clear_due"), ("calendar_update", "clear_end"), ("recurring_update", "until"), ("recurring_update", "clear_until"),
            ("notes_search", "folder"), ("notes_search", "tag"),
        ] {
            assert!(props(tool).get(arg).is_some(), "{tool} {arg}");
        }
        // nothing here says a bucket is made on the way any more
        for t in defs() {
            assert!(!t.description.contains("is created") && !t.description.contains("makes a bucket"), "{}", t.name);
        }
    }

    #[test]
    fn a_transcript_in_turns_and_pages() {
        let out = json!({ "ready": true, "segments": [
            { "t": 0.0, "end": 2.0, "speaker": "S1", "is_final": true, "text": "Hello" },
            { "t": 2.0, "end": 3.0, "speaker": "S1", "is_final": true, "text": "everyone." },
            { "t": 3.0, "end": 4.0, "speaker": "S2", "is_final": false, "text": "partial" },
            { "t": 3725.4, "end": 3727.0, "speaker": "S2", "is_final": true, "text": "Hi." },
            { "t": 3728.0, "end": 3729.0, "is_final": true, "text": " " },
        ] });
        let all = transcript_page(&out, 0, 20_000);
        assert_eq!(all["text"], "[0:00:00] S1: Hello everyone.\n[1:02:05] S2: Hi.");
        assert_eq!((all["ready"].clone(), all["next_offset"].clone()), (json!(true), Json::Null));
        // a page ends at a line's end, and the next one starts there
        let first = transcript_page(&out, 0, 35);
        assert_eq!(first["text"], "[0:00:00] S1: Hello everyone.\n");
        let next = first["next_offset"].as_u64().unwrap() as usize;
        assert_eq!(transcript_page(&out, next, 35)["text"], "[1:02:05] S2: Hi.");
        assert_eq!(transcript_page(&json!({ "segments": [], "text": "", "ready": false }), 0, 1000)["ready"], false);
    }

    #[test]
    fn a_session_row_without_the_vaults_own() {
        let row = session_row(&json!({ "id": "1", "user_id": "u", "transcript_storage_key": "k", "running_summary": "long", "title": "Standup" }));
        assert_eq!(row, json!({ "id": "1", "title": "Standup" }));
    }

    #[test]
    fn a_search_hit_in_plain_words() {
        assert_eq!(plain("a <b>pasta</b> &amp; &lt;b&gt; &quot;x&quot; it&#x27;s"), "a pasta & <b> \"x\" it's");
        let out = json!({ "data": [
            { "id": "1", "title": "Pasta", "folder": "/recipes", "tags": ["food"], "headline": "<b>pasta</b> al forno", "score": 0.3 },
            { "id": "2", "title": "Notes", "folder": null, "tags": [] },
        ], "total": 2 });
        assert_eq!(search_hits(&out), json!({ "count": 2, "results": [
            { "id": "1", "title": "Pasta", "folder": "/recipes", "tags": ["food"], "snippet": "pasta al forno" },
            { "id": "2", "title": "Notes", "folder": "/", "tags": [], "snippet": "" },
        ] }));
    }
}

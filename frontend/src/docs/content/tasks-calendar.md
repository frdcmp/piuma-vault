# Tasks, Calendar & Agenda

The vault includes a full productivity layer: one-off and recurring tasks, a
calendar of events, shared buckets and tags, and a consolidated agenda. These are
the `tasks`, `calendar`, `buckets`, and `agenda` backend apps.

## Tasks

Tasks have priority levels and due dates, with full CRUD and a quick completion
toggle. Manual ordering uses a **fractional index**: each task's rank is stored as
order-stable text so drag-to-reorder computes a new key *between* two neighbors
without renumbering the list — see `frontend/src/utils/rank.js` and the mobile
`fractional-indexing` dependency.

## Recurring tasks

Recurring tasks are RRULE-based templates that expand into occurrences. A template
like `FREQ=WEEKLY;BYDAY=MO,WE,FR` produces occurrences; completing one marks that
specific date done without altering the template. The front end expands recurrence
with `frontend/src/utils/recurrence.js`.

## Buckets and relational tags

- **Buckets** group tasks — each task belongs to at most one bucket.
- **Tags** are flat and independent, shared across tasks and calendar events. They
  are synced by name and auto-created when first used.

The UI filters by bucket and tag with AND logic (`BucketTagFilter`,
`ManageBucketsModal`, `TagPicker`).

## Calendar

Calendar events support recurrence, alerts (which feed the notification scheduler),
and tags. The web calendar offers a month grid and continuous scroll; the mobile
calendar offers month / week / 3-day views. **The week starts on Monday**
everywhere (web and mobile).

## Agenda

A consolidated read-only view of what's coming up: it merges one-off tasks,
expanded recurring occurrences, and calendar events into a single upcoming list —
also exposed to the LLM agent as a tool.

## Live updates

Tasks, calendar, and tags each have an SSE bus, so reordering a task or moving an
event on one device updates the others immediately.

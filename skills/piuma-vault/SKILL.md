---
name: piuma-vault
description: Read, search, create, edit, move and delete the notes in Piuma Vault — the user's self-hosted second brain — plus its tasks, recurring tasks, buckets, calendar events, a merged agenda, and its Inbox (Pigeon — the user's WhatsApp, Instagram and Gmail in one place, its people, drafts, rules and switches). Use whenever the user asks about "my notes", "the vault", a recipe/contact/credential/project note, about their tasks, to-dos, what's due, what's on their calendar, their agenda for today/this week, or about their Inbox or Pigeon — what needs them, a chat or message, someone's WhatsApp/email, a person's name or @slug, naming people from WhatsApp, drafting a reply, a pending draft, an Inbox rule, a reply or alert switch — or wants any of that created, edited, completed, rescheduled or deleted.
---

# Piuma Vault

The user's self-hosted Rust/Postgres app (`~/docker/piuma-vault`), served at whatever host
`VAULT_URL` names — this repo is public, so the instance is named in local config, never here.

**If the vault's MCP server is connected — directly or through a gateway that may prefix the
tool names (e.g. `vault_notes_search`) — use its tools; otherwise the scripts below with a
key** (*Without MCP: the scripts*). Tool names here are unprefixed: match them by their
ending. The server lists only the tools the caller's scopes allow, so a tool that's missing
is a scope that's missing (see *Scopes*), not a reason to go around it.

## The tools

**Notes** (markdown notes in a folder tree)

| Tool | |
|---|---|
| `notes_search` | by meaning and words; start here |
| `notes_list` | newest-updated first; `folder` (exactly that path), `tag`, `limit`, `offset` |
| `notes_get` | one note in full |
| `notes_browse` · `notes_folders` · `notes_find_folders` · `notes_tags` | navigation |
| `notes_create` | title, content, folder, tags |
| `notes_update` | title / content / folder / tags; **content replaces the body**; folder moves it |
| `notes_append` | adds after a blank line |
| `notes_replace_text` | one exact passage → new text |
| `notes_move_folder` | a whole folder and its subfolders |
| `notes_delete` | **soft** delete → trash |
| `notes_trash` · `notes_restore` | the trash, and back from it |
| `notes_versions` · `notes_version_get` · `notes_version_restore` | every save is a version |

**Tasks, recurring tasks, buckets, calendar, agenda**

| Tool | |
|---|---|
| `agenda` | tasks due, events and recurring occurrences in a range (default the next 7 days), plus the user's `timezone` |
| `tasks_list` · `tasks_get` | open tasks by default (`include_done`), `tag`, `bucket`; sorted by due date |
| `tasks_create` · `tasks_update` · `tasks_set_done` · `tasks_delete` | |
| `recurring_list` · `recurring_get` | RRULE templates |
| `recurring_create` · `recurring_update` · `recurring_complete` · `recurring_delete` | `recurring_complete` ticks one occurrence (`done: false` unticks) |
| `buckets_list` · `buckets_create` · `buckets_update` · `buckets_delete` | named groups of tasks |
| `calendar_list` · `calendar_get` | `from` / `to` (default the next 30 days) |
| `calendar_create` · `calendar_update` · `calendar_delete` | |

**The Inbox (Pigeon)**: the `pigeon_*` tools (see *The Inbox*).

---

# Notes

## Note rules

- **Always link every note you created, edited, appended to, moved or restored** in your
  reply, so the user can open it straight from the chat: `<vault host>/notes/<uuid>`, the
  host from `VAULT_URL` in `~/.config/piuma-vault/env` (or the host of the MCP server, when
  connected directly), the UUID from the tool's answer. It's `/notes/`, not `/admin/notes/`
  (that path is the API). One link per note, next to its title; if you don't know the host,
  give the title and the id.
- **Read before you write.** `notes_search` first — the vault already has a note for most
  topics, and appending to it beats creating a near-duplicate. `notes_get` before changing a
  note; reuse an existing folder (`notes_find_folders`) verbatim.
- **`notes_delete` is soft** (the note keeps its content and attachments, `notes_restore`
  brings it back). Confirm with the user first. Purging a note or emptying the trash are
  irreversible (they also drop the note's attachments): not over MCP; the scripts do them
  with `--yes`, and only after the user confirms.
- `notes_restore` takes the **id from `notes_trash`**; search can't see trashed notes.
- **`notes_update`'s `content` replaces the body.** To add use `notes_append`; to change one
  passage `notes_replace_text` (copy `old_text` verbatim from `notes_get`, it must match once).
- Folders are just a string on each note, created by using them and gone when the last note
  leaves. `notes_move_folder` rewrites the path prefix across the folder *and its subfolders*.
- Never paste a note's body into a public place, a commit, or an issue. The vault is a
  personal second brain: assume any note may hold credentials or personal data, and check
  before quoting one anywhere it leaves this machine.

## Note facts that bite

- Content is **markdown**, max 1 MB. Title max 500 chars, max 20 tags, folder path max 255
  chars and must start with `/`.
- Tags are normalized server-side to lowercase-with-hyphens (`"Project Plans"` → `project-plans`).
  A visible tag goes inline in the body as `#tag`; `tags` are stored beside it.
- Search embeds the query and merges vector, full-text and fuzzy-title results; if embedding
  fails it silently falls back to full-text, so results can vary run to run.
- Saving re-queues an embedding job in the background — a brand-new note may not surface in
  semantic search for a few seconds.
- Every save writes a version, so a bad update is recoverable: `notes_versions` →
  `notes_version_restore` (what the note held becomes a version too).

---

# Tasks & calendar

## Task & calendar rules

- **Deleting a task, recurring task, event or bucket is permanent — there is no trash**
  (unlike notes). Confirm with the user first. To finish a task, `tasks_set_done`; to silence
  a recurring task, `recurring_update` with `active: false` rather than deleting it. Deleting
  a bucket keeps its tasks, in no bucket.
- **Times are UTC in the API.** Give them as RFC 3339 with an offset
  (`2026-11-07T18:00:00+01:00`, or `Z`); a bare date or a time without an offset is refused.
  Say them to the user in their own timezone (`agenda` returns it as `timezone`).
- Buckets are named groups, one per project or life area (`buckets_list`). Tools take a
  bucket by **name**; over MCP an unknown name makes a new bucket, so check the list first.
  `"none"` takes a task out of its bucket.
- Tags on tasks/events are a shared registry, lowercased, auto-created on use. They are a
  different namespace from note tags.
- Priority is `0..3` = none/low/medium/high.
- Alerts are minutes before the due time / start (0 = at it), each a push and an alarm on the
  phone. **Alerts need a due date** — a task without `due_at` can't have them.
- Updates change only the fields given, and can't clear one (a due date, an event's end, a
  recurring task's `until`): the scripts do that (`--clear-due`, `--clear-end`, `--until`).

## Task & calendar facts that bite

- **Recurring tasks are never materialized until completed.** The backend stores templates;
  `agenda` expands them (in UTC dates: FREQ DAILY/WEEKLY/MONTHLY, INTERVAL, BYDAY, UNTIL,
  COUNT). `recurring_complete` inserts a done task for that date; `done: false` deletes it.
- **An event's `rrule` is stored but expanded nowhere** — not by the API, not by the web UI,
  not by the scripts. A recurring *event* shows up once, on its first date. Use a recurring
  *task* for anything that must repeat.
- `agenda` covers a window only: overdue tasks are the open ones in `tasks_list` whose
  `due_at` is past (it sorts them first).
- `tasks_list` returns one-off tasks only (at most 200); recurring ones are in
  `recurring_list` and, by occurrence, in `agenda`.

---

# The Inbox

Pigeon is the vault's Inbox: the user's WhatsApp, Instagram and Gmail in one place, with
people (each an `@slug`, their handles on every channel), Pigeon's drafts and suggestions
waiting for the user, rules for what a sender keeps sending, and per-person switches (may
Pigeon reply: off / ask / auto; how loud on the phone: all / smart / quiet / off).

The `pigeon_*` tools are the ones Piuma (the vault's assistant) has, run as the user. Start
with `pigeon_inbox` (what needs them) or `pigeon_pending` (what waits for their yes);
`pigeon_conversation` reads a chat, `pigeon_search` every message, `pigeon_contacts` the
people (a `contact_id` is the id it gives; find someone by `@slug` with `query`). Each tool's
description says what it takes.

## Inbox rules

- **A message goes only on the user's word.** By default it's a **draft** the user sends from
  the Inbox (`pigeon_draft_reply`, `pigeon_draft_email`, `pigeon_edit_draft`). When they say
  send it: show them the exact text first, then `pigeon_send_reply` (new words) or
  `pigeon_approve` (a waiting draft).
- **Never set a policy to `auto`** (`pigeon_set_policy`, `pigeon_set_auto`) unless the user
  asks for it.
- Big changes (merging two people, deleting a rule, switching auto) don't run: they come
  back as a card the user taps in the Inbox. Say so rather than retrying.
- **Who may be told what** (`pigeon_access`, `pigeon_grant`, `pigeon_revoke`, the groups): a
  permission is `tool.level.mode` from the catalogue `pigeon_access` gives
  (`location.city.ask`). Grant only what the user asked, for whom they said. Mode `ask` still
  shows them every answer first; mode `auto` (or a place in a group that holds one) is Pigeon
  answering on its own: only when they ask for it, and it comes back as a card they tap.
- **Notes** (`notes.use.ask|auto`) is given on one note (`note_id`) or one folder (`folder`:
  every note in and under it, the ones added later too), never on all of them: `*` doesn't
  reach it, and someone can hold several. Pigeon then answers from that note when they ask
  for what is in it. `/contacts` (what the user and Pigeon keep on people) and `/` are
  refused: what is shared lives elsewhere, e.g. `/shared/…`. Say which note or folder and
  to whom before granting, and never move a note into a shared folder without the user's word.
  `pigeon_shared_notes` lists what is shared and with whom.
- **What Pigeon knows** (`pigeon_facts`, `pigeon_set_fact`): the user's place (their phone
  writes it; `pigeon_set_fact` only when they say where they are, with just the levels they
  said). It is told to other people: only on the user's word.
- **Instructions** (`pigeon_instructions`, `pigeon_set_instructions`, `pigeon_set_note`): the
  user's own words on how Pigeon writes and what it does, read every time it works in a chat.
  Three levels: for every chat, on one person (their note), for one chat or group chat; the
  most specific wins. `text` replaces what was there, so read first and write the whole. They
  never let Pigeon tell more about the user: that is a permission (`pigeon_grant`). Only on
  the user's word.
- Messages are the user's private conversations: quote only what the task needs, and never
  into a commit, an issue or anywhere public.
- Find people with `pigeon_contacts` before changing them; a handle that is someone else's is
  refused (the same person twice is `pigeon_merge_contacts`).

## Inbox facts that bite

- A message's text says only `[image]` or `[voice message]`: what was sent is in its
  `files` (kind, name, a voice note's `transcript`, `status`). The tools describe files but
  don't fetch them: to see a photo or read a document, `pigeon.py file` (the scripts). Only a
  `stored` file can be had: `expired` and `gone` ones are no longer kept.
- **Files on an email**: `files` on `pigeon_draft_email`, or on `pigeon_draft_reply` and
  `pigeon_send_reply` in an email conversation, takes the `file` objects an upload returned
  (`pigeon.py upload <path>`, or `POST /admin/pigeon/files`, multipart `file`, `inbox.write`).
  At most 10 files and 25 MB in all; email only (WhatsApp and Instagram replies take none);
  a draft's card in the Inbox lists them, so say which files go when you show the text.
- When someone asks for something they hold no permission for, the user gets a 🔑 card in
  the Inbox (answer this once, allow, no); with `ask` the answer is a draft that says what it
  uses; with `auto` it goes out only when Jev is sure they asked, for themselves and nothing
  else, and the reply read back says no more than their level. A place older than 30 minutes
  and a calendar with repeating events are never told on Pigeon's own. Asked for the place
  by someone who may know it while the phone has sent none (its switch is off): nothing is
  told, the chat says so (a news line: switch your place on in the app), and Pigeon asks no
  question about it.
- In `pigeon_pending` a 🔑 card is kind `uncovered` (`asks_for`: the tool). `pigeon_answer`
  on it takes `once` (Pigeon drafts the answer for this time, with the least that answers),
  `granted` (after a `pigeon_grant`: Pigeon drafts with it) or `no`. While telling is paused
  (`pigeon_access`: `paused`) only `no` works.
- Notes: Pigeon searches only the notes that chat holds, Jev picks one or none, and the reply
  answers from that one note (its text, never its attachments). On its own (`auto`) only when
  Jev is sure of the question and of the note, the note fits whole (8000 characters) and
  the reply holds no card number (an account number or an IBAN goes): otherwise a draft,
  and its card says why. A note in the trash or moved to `/contacts` is no longer read; a
  renamed folder keeps its grants; a 🔑 card for a note names it (`note`), and allowing it
  grants that one note. `pigeon_try_permission` doesn't take Notes.
- What Pigeon knows about a person is notes in their folder of the vault,
  `/contacts/<person>/` (a group chat has one too): `Pigeon · Memory` and
  `Pigeon · Style · <Channel>`, tagged `pigeon`, beside the user's own notes there, which
  Pigeon also reads before writing to them. They are the user's to edit (the notes tools):
  an edit wins, the next rewrite keeps it. Don't delete them or rename them.
- A person known only by a number takes the name their next message carries on its own;
  `pigeon_names_from_whatsapp` does it now from the phone's address book (and gives the slug).
- `pigeon_learn` brings old conversations in and writes what Pigeon knows about people: slow,
  it runs in the background without `contact_id`.

---

## Scopes

What a caller may do is its scopes (a vault API key's, set in admin → API Keys):

| Tools | Read | Write |
|---|---|---|
| `notes_*` | `notes.read` | `notes.write` |
| `tasks_*`, `recurring_*` | `tasks.read` or `tasks.manage` | `tasks.write` or `tasks.manage` |
| `calendar_*` | `calendar.read` or `calendar.manage` | `calendar.write` or `calendar.manage` |
| `buckets_*` | any tasks or calendar read | any tasks or calendar write |
| `agenda` | tasks or calendar read: it shows only the parts the caller may read | |
| `pigeon_*` | `inbox.read` | `inbox.write` |

Groups and grants (`pigeon_set_group`, `pigeon_grant`, `pigeon_revoke`, `pigeon_mark_wrong`)
need their own scope, **`inbox.access`**. Signed in through a gateway (OAuth), its read scope
gives every read above and its write scope every write, but never `inbox.access`: those four
need a vault key that carries it. A tool's error *"This key can't: it needs the … scope"*, or
a script's `403 … permission required`, means the scope is missing; a `401` means the key is
wrong, revoked, or expired.

---

# Without MCP: the scripts

Three scripts in `scripts/`, beside this file, cover the same, with a key (see *Credentials*).
They are not on `PATH`: invoke them by full path — on this machine
`~/.claude/skills/piuma-vault/scripts/vault.sh`, a symlink into the checkout. Run any with
`help` / `--help` for the full flag list. Don't hand-roll curl unless an endpoint isn't wrapped.

| Script | Covers |
|---|---|
| `scripts/vault.sh` | **notes**: `list`, `search`, `get [--raw]`, `browse`/`folders`/`findfolder`/`tags`, `new`, `edit` (body replaces), `append`, `mv`, `mvfolder`, `rm` (soft), `trash`, `restore <uuid>`, `versions [--get\|--restore]`, and the irreversible `purge <id> --yes` / `empty-trash --yes` |
| `scripts/agenda.py` | `today` / `week` / `month` / `agenda [--from --to \| --days] [--tag]` (overdue first, then per day 📅 events, ☐ tasks, ↻/☑ recurring); `tasks list\|get\|add\|edit\|done\|undone\|rm --yes\|buckets`; `recurring list\|get\|add\|edit\|rm --yes\|complete [--date] [--undo]`; `cal list\|get\|add\|edit\|rm --yes` |
| `scripts/pigeon.py` | the Inbox: each command is a `pigeon_*` tool without its prefix, arguments `key=value` (JSON when it parses, `-` reads stdin, `--json '{…}'`); `contact_id` / `merge_id` take an `@slug`; `tools [name]` lists them (`w` = writes); plus its own `file item=… file=…` (saves a message's file under `~/.cache/piuma-vault/files`, prints the path) and `upload <path>` (prints the `file` object; or `attach=<path>` on a draft or send) |

What differs from the tools:

- Any `<id|title>` takes a UUID or a title: an exact (case-insensitive) title wins, otherwise
  it must be unique or the script lists the candidates and stops. Prefer UUIDs in bulk.
- `agenda.py` takes ISO (`2026-11-07`, `2026-11-07 18:00`) **or** natural language via GNU
  date (`"tomorrow 18:00"`), in the machine's local timezone, and shows local times. It
  composes its views from `/admin/tasks`, `/admin/calendar/events` and
  `/admin/recurring-tasks`, expanding RRULEs locally (python-dateutil).
- `agenda.py --bucket <name>` resolves an existing bucket; an unknown name is an error (it
  doesn't make one). `tasks list` also takes `--overdue`, `--due-before`, `--due-after`,
  `--no-bucket`.
- The API: notes under `/admin/notes`, `GET /admin/calendar/events` **requires** `from` and
  `to`, the task list is clamped to 200. Cloudflare fronts the vault and 403s (its error 1010)
  on unusual User-Agents — `agenda.py` sends its own; anything new that talks to the API must
  set one too.

## Credentials

The scripts resolve, in order: exported `VAULT_API_KEY` → `~/.config/piuma-vault/env`
(`VAULT_URL=` / `VAULT_API_KEY=`) → `~/docker/piuma-vault-mobile/.env`.

Both `VAULT_URL` and `VAULT_API_KEY` are **required** — the scripts exit 2 rather than
guess a host. Mint a dedicated key in the vault UI (admin → API Keys) with the scopes it
needs (see *Scopes*), then write both to `~/.config/piuma-vault/env`:

```sh
install -Dm600 /dev/stdin ~/.config/piuma-vault/env <<'EOF'
VAULT_URL=https://your-vault.example
VAULT_API_KEY=your-key-here
EOF
```

Give the scripts their own key rather than reusing one issued to another client, so it can
be revoked on its own. None of these files are in the repo, and no key belongs in one.

The same key works for the MCP server: `$VAULT_URL/api/v1/mcp` (streamable HTTP, the key in
an `x-api-key` header). The older standalone Pigeon (its own `pigeon` MCP and database) is gone.

---

## Installing this skill somewhere else

The skill lives **inside the piuma-vault checkout**, at `skills/piuma-vault/` — SKILL.md
plus the scripts. It is versioned with the Rust code it drives, so an endpoint change
and the skill note describing it land in the same commit.

**Symlink it into place rather than copying it.** A copy forks the moment either side is
edited, and the copy under `~/.claude/skills` is the one nobody remembers to update — so it
silently describes an older API than the one deployed.

```bash
ln -s "$PWD/skills/piuma-vault" ~/.claude/skills/piuma-vault   # run from a checkout
```

The target has to be **absolute**. A relative one resolves against the link's own directory,
not the working directory, producing a dead link that looks fine in `ls`.

Two places it can go:

| | |
| :--- | :--- |
| `~/.claude/skills/` | every project, this user |
| `<project>/.claude/skills/` | that project only — commit the link and a pull brings it |

**For this repo the project-scoped link is already committed**, as
`.claude/skills/piuma-vault -> ../../skills/piuma-vault`. A relative target is right there
because it resolves against the link's own directory, so it lands on the checkout's own
`skills/piuma-vault` whatever path the clone sits at. Pulling the repo is therefore enough
to get the skill inside this project; the `ln -s` above is only for using it elsewhere.

If a copied `piuma-vault/` is already sitting there, delete it first. `ln -s` will not
replace a directory — handed an existing one it creates the link *inside* it, leaving
`~/.claude/skills/piuma-vault/piuma-vault`, which Claude Code does not load and which looks
like it worked.

Check it took:

```bash
ls -l ~/.claude/skills/piuma-vault   # -> /path/to/piuma-vault/skills/piuma-vault
```

The scripts need an API key, which is **not** in the checkout — see *Credentials* above.

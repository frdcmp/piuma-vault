---
name: piuma-vault
description: Read, search, create, edit, move and delete the notes in Piuma Vault — the user's self-hosted second brain — plus its tasks, recurring tasks, buckets, calendar events, and a merged agenda. Use whenever the user asks about "my notes", "the vault", a recipe/contact/credential/project note, or about their tasks, to-dos, what's due, what's on their calendar, their agenda for today/this week, or wants any of that created, edited, completed, rescheduled or deleted.
---

# Piuma Vault

The user's self-hosted Rust/Postgres app (`~/docker/piuma-vault`), served at whatever
host `VAULT_URL` names — this repo is public, so the instance is named in local config,
never here. Two scripts cover it, both authenticating the same way:

| Script | Covers |
|---|---|
| `scripts/vault.sh` | **notes** — markdown notes in a folder tree; run `folders` to see the live layout |
| `scripts/agenda.py` | **tasks, recurring tasks, buckets, calendar events, agenda** |

Both sit in `scripts/`, beside this file. They are not on `PATH`, so invoke them by full
path — on this machine `~/.claude/skills/piuma-vault/scripts/vault.sh`, which is a symlink
into the checkout (see *Installing this skill* at the end). Run either with `help` /
`--help` for the full flag list. Don't hand-roll curl unless an endpoint isn't wrapped.

---

# Notes — `vault.sh`

## Commands

| | |
|---|---|
| `list [--folder /f] [--tag t] [--limit N] [--offset N]` | newest-updated first |
| `search "query" [--folder /f] [--tag t] [--limit N]` | hybrid FTS + pgvector + trigram, with match snippets |
| `get <id\|title> [--raw] [--json]` | `--raw` = markdown body only |
| `browse [/path]` · `folders` · `findfolder "q"` · `tags` | navigation |
| `new "Title" [--folder /f] [--tags a,b]` + body on stdin/`--content`/`--file` | |
| `edit <id\|title> [--title T] [--folder /f] [--tags a,b]` + new body | body replaces, doesn't merge |
| `append <id\|title>` + body | adds after a blank line |
| `mv <id\|title> /new/folder` · `mvfolder /from /to` | one note · a whole subtree |
| `rm <id\|title>` | **soft** delete → trash |
| `trash` · `restore <uuid>` · `purge <id> --yes` · `empty-trash --yes` | |
| `versions <id> [--get <vid>] [--restore <vid>]` | every save is snapshotted |

Any `<id|title>` accepts a UUID or a title. A title is resolved by search: an exact
(case-insensitive) title wins, otherwise it must be unique or the script lists the
candidates and stops. Prefer UUIDs from a previous `list`/`search` when acting in bulk.

## Note rules

- **Read before you write.** `search` first — the vault already has a note for most topics,
  and appending to it beats creating a near-duplicate.
- **`rm` is soft** (sets `deleted_at`, note keeps content and attachments). It's the default
  for "delete this note". `purge` and `empty-trash` are irreversible — they also drop the
  note's S3 attachments — so both demand `--yes`, and you should confirm with the user first.
- `restore` only takes a **UUID from `vault.sh trash`**; search can't see trashed notes.
- **`edit` replaces the body.** To add to a note use `append`, or `get --raw` → modify → `edit`.
- Folders are just a string column, created implicitly by using them and gone when the last
  note leaves. `mvfolder` rewrites the path prefix across the folder *and its subfolders*.
- Never paste a note's body into a public place, a commit, or an issue. The vault is a
  personal second brain: assume any note may hold credentials or personal data, and check
  before quoting one anywhere it leaves this machine.

## Note API facts that bite

- Notes live under `/admin/notes` (see `rust/src/apps/notes/routes.rs`).
- Content is **markdown** (BlockNote/Milkdown both round-trip it), max 1 MB.
  Title max 500 chars, max 20 tags, folder path max 255 chars and must start with `/`.
- Tags are normalized server-side to lowercase-with-hyphens (`"Project Plans"` → `project-plans`).
- Search embeds the query (Azure OpenAI) and RRF-merges three candidate pools; if embedding
  fails it silently falls back to FTS-only, so results can vary run to run.
- Saving re-queues an embedding job in the background — a brand-new note may not surface in
  semantic search for a few seconds.
- Every update writes a version row, so a bad `edit` is recoverable via `versions --restore`.

---

# Tasks & calendar — `agenda.py`

```
agenda.py today | week | month | agenda [--from X --to Y | --days N] [--tag t]
```
The merged day-by-day view: overdue tasks first, then per day the calendar events (📅),
tasks due (☐) and recurring-task occurrences (↻ pending, ☑ done).

| | |
|---|---|
| `tasks list [--all\|--done\|--overdue] [--tag t] [--bucket b\|--no-bucket] [--due-before X] [--due-after X]` | open tasks by default |
| `tasks get <id\|title>` · `tasks buckets` | detail · buckets with open/total counts |
| `tasks add "Title" [--due WHEN] [--priority none\|low\|medium\|high] [--bucket b] [--tags a,b] [--notes N]` | |
| `tasks edit <id\|title> [--title][--due WHEN\|--clear-due][--priority][--bucket b\|--no-bucket][--tags][--notes]` | |
| `tasks done <id\|title>` · `tasks undone` · `tasks rm <id> --yes` | |
| `recurring list\|get <ref>` | RRULE templates, with the next occurrences expanded |
| `recurring add "Title" --rrule FREQ=WEEKLY;BYDAY=MO [--dtstart][--until][--bucket][--tags]` | |
| `recurring edit <ref> [--rrule][--dtstart][--until][--active true\|false][…]` · `recurring rm <ref> --yes` | |
| `recurring complete <ref> [--date YYYY-MM-DD] [--undo]` | ticks one occurrence (default today) |
| `cal list [--from X --to Y \| --days N] [--tag t]` · `cal get <id\|title>` | |
| `cal add "Title" --start WHEN [--end WHEN] [--all-day] [--location L] [--desc D] [--tags a,b] [--rrule R]` | |
| `cal edit <id\|title> [--start][--end\|--clear-end][--all-day true\|false][--location][--desc][--tags]` · `cal rm <ref> --yes` | |

`--due`, `--start`, `--from` etc. take ISO (`2026-11-07`, `2026-11-07 18:00`) **or** natural
language via GNU date (`"tomorrow 18:00"`, `"next monday"`). All input and display is in the
machine's local timezone (Europe/Rome); the API stores UTC. Any `<id|title>` accepts a UUID
or a unique title substring, same as notes.

## Task & calendar rules

- **Deleting a task or event is permanent — there is no trash** (unlike notes). Both `rm`s
  demand `--yes`; confirm with the user first. To silence a recurring task, prefer
  `recurring edit <ref> --active false` over deleting the template.
- Buckets are named groups, one per project or life area; run `agenda.py tasks buckets`
  to list them. Pass `--bucket <name>` and the script resolves the id.
  Unlike tags, a bucket is **not** created on the fly here — an unknown name is an error.
- Tags on tasks/events are a shared registry, lowercased, auto-created on use. They are a
  different namespace from note tags.
- Priority is `0..3` = none/low/medium/high; `!high` in listings.
- Alerts need a due date — the API rejects alerts on a task without `due_at`.

## Task & calendar facts that bite

- **`GET /admin/agenda` is broken (500).** `agenda/handlers.rs`'s `RECURRING_FIELDS` omits
  `bucket_id`, which `RecurringTask` requires, so the row decode fails whenever an active
  template exists. `agenda.py` therefore composes the view client-side from
  `/admin/tasks` + `/admin/calendar/events` + `/admin/recurring-tasks`. Adding `bucket_id, `
  to that constant fixes the endpoint, but needs a backend rebuild + deploy.
- **Recurring tasks are never materialized until completed.** The backend stores templates
  only; the web UI, the mobile app and this script each expand the RRULE locally
  (here via python-dateutil). Completing an occurrence inserts a `db_tasks` row;
  `--undo` deletes it again.
- **An event's `rrule` is stored but expanded nowhere** — not by the API, not by the web
  UI (`CalendarPage.jsx` buckets each event on its start day only), not here. A recurring
  *event* shows up once, on its first date. Use a recurring *task* for anything that must
  repeat.
- `GET /admin/calendar/events` **requires** `from` and `to`; there is no "all events" call.
- The task list endpoint returns everything by default; `--limit` is clamped to 200
  server-side.
- Cloudflare fronts the vault and 403s (its error 1010) on unusual User-Agents — `agenda.py`
  sends its own. Anything new that talks to the API must set one too.

---

## Credentials

The script resolves, in order: exported `VAULT_API_KEY` → `~/.config/piuma-vault/env`
(`VAULT_URL=` / `VAULT_API_KEY=`) → `~/docker/piuma-vault/piuma-vault-mobile/.env`.

Both `VAULT_URL` and `VAULT_API_KEY` are **required** — the scripts exit 2 rather than
guess a host. Mint a dedicated key in the vault UI (admin → API Keys) scoped to
`notes.read` + `notes.write`, then write both to `~/.config/piuma-vault/env`:

```sh
install -Dm600 /dev/stdin ~/.config/piuma-vault/env <<'EOF'
VAULT_URL=https://your-vault.example
VAULT_API_KEY=your-key-here
EOF
``` Give the
scripts their own key rather than reusing one issued to another client, so it can be
revoked on its own. None of these files are in the repo, and no key belongs in one.
A `403 … permission required` means the key lacks the scope; a `401` means it's wrong,
revoked, or expired.

---

## Installing this skill somewhere else

The skill lives **inside the piuma-vault checkout**, at `skills/piuma-vault/` — SKILL.md
plus the two scripts. It is versioned with the Rust code it drives, so an endpoint change
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
| `<project>/.claude/skills/` | that project only — commit the link and the team gets it |

If a copied `piuma-vault/` is already sitting there, delete it first. `ln -s` will not
replace a directory — handed an existing one it creates the link *inside* it, leaving
`~/.claude/skills/piuma-vault/piuma-vault`, which Claude Code does not load and which looks
like it worked.

Check it took:

```bash
ls -l ~/.claude/skills/piuma-vault   # -> /path/to/piuma-vault/skills/piuma-vault
```

The scripts need an API key, which is **not** in the checkout — see *Credentials* above.

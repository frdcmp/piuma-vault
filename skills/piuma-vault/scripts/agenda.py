#!/usr/bin/env python3
"""Piuma Vault — tasks, recurring tasks, calendar events, and a merged agenda.

Companion to vault.sh (notes). Same vault, same x-api-key auth. Python rather
than shell because everything here is dates: the API speaks UTC instants, the
user thinks in local time, and recurring tasks are RRULEs that have to be
expanded to be useful.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path

LOCAL = datetime.now().astimezone().tzinfo
PRIORITY = ["none", "low", "medium", "high"]
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def die(msg: str, code: int = 1):
    print(f"agenda: {msg}", file=sys.stderr)
    raise SystemExit(code)


# ── Credentials ───────────────────────────────────────────────────────────
# Same precedence as vault.sh: env → ~/.config/piuma-vault/env → mobile .env.
def load_creds() -> tuple[str, str]:
    url, key = os.environ.get("VAULT_URL"), os.environ.get("VAULT_API_KEY")
    for path in (Path(os.environ.get("VAULT_CONFIG", Path.home() / ".config/piuma-vault/env")),
                 Path.home() / "docker/piuma-vault/piuma-vault-mobile/.env"):
        if key:
            break
        if not path.is_file():
            continue
        for line in path.read_text().splitlines():
            m = re.match(r'^\s*(VAULT_URL|SITE_URL|VAULT_API_KEY)\s*=\s*"?([^"#\s]+)"?', line)
            if not m:
                continue
            if m[1] == "VAULT_API_KEY" and not key:
                key = m[2]
            elif not url:
                url = m[2]
    if not key:
        die("no API key. Set VAULT_API_KEY or write ~/.config/piuma-vault/env")
    if not url:
        die("no vault URL. Set VAULT_URL or write ~/.config/piuma-vault/env")
    return url.rstrip("/") + "/api/v1", key


API, KEY = "", ""


def call(method: str, path: str, body=None, params: dict | None = None):
    url = API + path
    if params:
        url += "?" + urllib.parse.urlencode({k: v for k, v in params.items() if v is not None})
    data = json.dumps(body).encode() if body is not None else None
    # Cloudflare sits in front of the vault and rejects urllib's default
    # User-Agent with a 403 (its own error 1010, not an app error), so send a
    # normal one.
    req = urllib.request.Request(url, data=data, method=method, headers={
        "x-api-key": KEY,
        "Content-Type": "application/json",
        "User-Agent": "piuma-vault-skill/1.0 (+claude-code)",
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except Exception:
            pass
        die(f"HTTP {e.code} on {method} {path}: {detail}")
    except urllib.error.URLError as e:
        die(f"cannot reach {API}: {e.reason}")


# ── Time ──────────────────────────────────────────────────────────────────
def parse_when(s: str, *, end_of_day: bool = False) -> datetime:
    """Accept ISO, 'YYYY-MM-DD', or anything GNU date understands ('tomorrow 18:00')."""
    s = s.strip()
    try:
        if re.fullmatch(r"\d{4}-\d{2}-\d{2}", s):
            d = date.fromisoformat(s)
            t = time(23, 59, 59) if end_of_day else time(0, 0)
            return datetime.combine(d, t, tzinfo=LOCAL)
        dt = datetime.fromisoformat(s.replace("Z", "+00:00"))
        return dt if dt.tzinfo else dt.replace(tzinfo=LOCAL)
    except ValueError:
        pass
    try:  # GNU date does the natural-language lifting
        out = subprocess.run(["date", "-d", s, "+%Y-%m-%dT%H:%M:%S%z"],
                             capture_output=True, text=True, check=True).stdout.strip()
        return datetime.strptime(out, "%Y-%m-%dT%H:%M:%S%z")
    except subprocess.CalledProcessError:
        die(f"cannot parse date {s!r}")


def to_utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_utc(s: str | None) -> datetime | None:
    if not s:
        return None
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(LOCAL)


def fmt(dt: datetime | None, *, day_only: bool = False) -> str:
    if dt is None:
        return "—"
    return dt.strftime("%a %d %b" if day_only else "%a %d %b %H:%M")


def window(args) -> tuple[datetime, datetime]:
    """--from/--to, else --days from today (default 7), midnight-anchored locally."""
    start = parse_when(args.frm) if getattr(args, "frm", None) else \
        datetime.now(LOCAL).replace(hour=0, minute=0, second=0, microsecond=0)
    if getattr(args, "to", None):
        end = parse_when(args.to, end_of_day=True)
    else:
        end = start + timedelta(days=getattr(args, "days", None) or 7)
    return start, end


# ── Shared helpers ────────────────────────────────────────────────────────
def buckets_by_name() -> dict[str, dict]:
    return {b["name"].lower(): b for b in call("GET", "/admin/buckets")}


def bucket_id(name: str | None) -> str | None:
    if not name:
        return None
    b = buckets_by_name().get(name.lower())
    if not b:
        die(f"no bucket named {name!r} — have: " +
            ", ".join(sorted(x['name'] for x in call('GET', '/admin/buckets'))))
    return b["id"]


def bucket_names() -> dict[str, str]:
    return {b["id"]: b["name"] for b in call("GET", "/admin/buckets")}


def resolve(ref: str, items: list[dict], what: str) -> dict:
    """A UUID, or a case-insensitive title substring that hits exactly one item."""
    if UUID_RE.match(ref):
        for it in items:
            if it["id"] == ref:
                return it
        die(f"no {what} with id {ref}")
    hits = [i for i in items if ref.lower() in i["title"].lower()]
    exact = [i for i in hits if i["title"].lower() == ref.lower()]
    if exact:
        return exact[0]
    if not hits:
        die(f"no {what} title matches {ref!r}")
    if len(hits) > 1:
        print(f"{ref!r} is ambiguous — {len(hits)} matches:", file=sys.stderr)
        for i in hits:
            print(f"  {i['id']}  {i['title']}", file=sys.stderr)
        raise SystemExit(1)
    return hits[0]


def tag_list(s: str | None) -> list[str] | None:
    if s is None:
        return None
    return [t.strip().lower() for t in s.split(",") if t.strip()]


def dump(obj):
    print(json.dumps(obj, indent=2, ensure_ascii=False))


# ── Tasks ─────────────────────────────────────────────────────────────────
def all_tasks(params: dict | None = None) -> list[dict]:
    return call("GET", "/admin/tasks", params=params) or []


def task_line(t: dict, bnames: dict[str, str]) -> str:
    due = parse_utc(t.get("due_at"))
    overdue = due and not t["done"] and due < datetime.now(LOCAL)
    mark = "x" if t["done"] else " "
    bits = [f"[{mark}] {t['id'][:8]}  {fmt(due):<16}"]
    if t.get("priority"):
        bits.append(f"!{PRIORITY[t['priority']]}")
    if t.get("bucket_id"):
        bits.append(f"@{bnames.get(t['bucket_id'], '?')}")
    line = " ".join(bits) + f"  {t['title']}"
    if t.get("tags"):
        line += "  [" + ",".join(t["tags"]) + "]"
    return line + ("   ⚠ OVERDUE" if overdue else "")


def cmd_tasks_list(args):
    params = {}
    if args.done:
        params["done"] = "true"
    elif args.all:
        pass
    else:
        params["done"] = "false"
    if args.tag:
        params["tag"] = args.tag
    if args.bucket:
        params["bucket"] = bucket_id(args.bucket)
    if args.no_bucket:
        params["no_bucket"] = "true"
    if args.due_before:
        params["due_before"] = to_utc(parse_when(args.due_before, end_of_day=True))
    if args.due_after:
        params["due_after"] = to_utc(parse_when(args.due_after))
    if args.limit:
        params["limit"] = args.limit
    tasks = all_tasks(params)
    now = datetime.now(LOCAL)
    if args.overdue:
        tasks = [t for t in tasks if not t["done"] and (d := parse_utc(t.get("due_at"))) and d < now]
    if args.json:
        return dump(tasks)
    bnames = bucket_names()
    tasks.sort(key=lambda t: (t["done"], parse_utc(t.get("due_at")) or datetime.max.replace(tzinfo=LOCAL),
                              -t.get("priority", 0)))
    for t in tasks:
        print(task_line(t, bnames))
    print(f"\n{len(tasks)} task(s)")


def cmd_tasks_get(args):
    t = resolve(args.ref, all_tasks(), "task")
    if args.json:
        return dump(t)
    bnames = bucket_names()
    print(f"{t['title']}\n{'-' * len(t['title'])}")
    print(f"id:        {t['id']}")
    print(f"done:      {t['done']}" + (f"  (at {fmt(parse_utc(t.get('completed_at')))})" if t["done"] else ""))
    print(f"due:       {fmt(parse_utc(t.get('due_at')))}")
    print(f"priority:  {PRIORITY[t.get('priority', 0)]}")
    print(f"bucket:    {bnames.get(t.get('bucket_id'), '—')}")
    print(f"tags:      {', '.join(t.get('tags') or []) or '—'}")
    if t.get("alerts"):
        print(f"alerts:    {json.dumps(t['alerts'])}")
    if t.get("notes"):
        print(f"\n{t['notes']}")


def priority_val(s: str | None) -> int | None:
    if s is None:
        return None
    if s.isdigit() and 0 <= int(s) <= 3:
        return int(s)
    if s.lower() in PRIORITY:
        return PRIORITY.index(s.lower())
    die(f"priority must be 0-3 or one of {'/'.join(PRIORITY)}")


def cmd_tasks_add(args):
    body = {"title": args.title, "tags": tag_list(args.tags) or []}
    if args.notes:
        body["notes"] = args.notes
    if args.due:
        body["due_at"] = to_utc(parse_when(args.due))
    if args.priority:
        body["priority"] = priority_val(args.priority)
    if args.bucket:
        body["bucket_id"] = bucket_id(args.bucket)
    t = call("POST", "/admin/tasks", body)
    print(f"created {t['id']}  {t['title']}  due {fmt(parse_utc(t.get('due_at')))}")


def cmd_tasks_edit(args):
    t = resolve(args.ref, all_tasks(), "task")
    body = {}
    if args.title:
        body["title"] = args.title
    if args.notes is not None:
        body["notes"] = args.notes
    if args.due:
        body["due_at"] = to_utc(parse_when(args.due))
    if args.clear_due:
        body["due_at"] = None
    if args.priority:
        body["priority"] = priority_val(args.priority)
    if args.bucket:
        body["bucket_id"] = bucket_id(args.bucket)
    if args.no_bucket:
        body["bucket_id"] = None
    if args.tags is not None:
        body["tags"] = tag_list(args.tags)
    if not body:
        die("nothing to change")
    r = call("PUT", f"/admin/tasks/{t['id']}", body)
    print(f"updated {r['id']}  {r['title']}  due {fmt(parse_utc(r.get('due_at')))}")


def cmd_tasks_done(args, done=True):
    t = resolve(args.ref, all_tasks(), "task")
    r = call("PUT", f"/admin/tasks/{t['id']}", {"done": done})
    print(("completed " if done else "reopened ") + f"{r['id']}  {r['title']}")


def cmd_tasks_rm(args):
    t = resolve(args.ref, all_tasks(), "task")
    if not args.yes:
        die(f"deleting a task is permanent (no trash): {t['title']!r}. Re-run with --yes")
    call("DELETE", f"/admin/tasks/{t['id']}")
    print(f"deleted {t['id']}  {t['title']}")


def cmd_buckets(args):
    bs = call("GET", "/admin/buckets")
    if args.json:
        return dump(bs)
    tasks = all_tasks()
    for b in bs:
        open_n = sum(1 for t in tasks if t.get("bucket_id") == b["id"] and not t["done"])
        total = sum(1 for t in tasks if t.get("bucket_id") == b["id"])
        print(f"{b['id']}  {b['name']:<16} {open_n} open / {total} total")
    loose = sum(1 for t in tasks if not t.get("bucket_id") and not t["done"])
    print(f"{'—' * 36}  {loose} open task(s) with no bucket")


# ── Recurring tasks ───────────────────────────────────────────────────────
def all_recurring() -> list[dict]:
    return call("GET", "/admin/recurring-tasks") or []


def expand_rrule(tmpl: dict, start: datetime, end: datetime) -> list[date]:
    """Expand a template's RRULE inside [start, end). dateutil is present on this box."""
    from dateutil.rrule import rrulestr
    dtstart = parse_utc(tmpl["dtstart"])
    until = parse_utc(tmpl.get("until"))
    stop = min(end, until) if until else end
    if stop <= start:
        return []
    try:
        rule = rrulestr(tmpl["rrule"], dtstart=dtstart)
    except Exception as e:
        print(f"agenda: bad rrule on {tmpl['title']!r}: {e}", file=sys.stderr)
        return []
    return [d.date() for d in rule.between(start, stop, inc=True)]


def cmd_recurring_list(args):
    rs = all_recurring()
    if args.json:
        return dump(rs)
    bnames = bucket_names()
    for r in rs:
        flag = "" if r["active"] else "  (inactive)"
        b = f"  @{bnames.get(r['bucket_id'])}" if r.get("bucket_id") else ""
        print(f"{r['id'][:8]}  {r['rrule']:<28} since {fmt(parse_utc(r['dtstart']), day_only=True)}"
              f"  {r['title']}{b}{flag}")
    print(f"\n{len(rs)} template(s)")


def cmd_recurring_get(args):
    r = resolve(args.ref, all_recurring(), "recurring task")
    if args.json:
        return dump(r)
    print(f"{r['title']}\nid:       {r['id']}\nrrule:    {r['rrule']}")
    print(f"dtstart:  {fmt(parse_utc(r['dtstart']))}\nuntil:    {fmt(parse_utc(r.get('until')))}")
    print(f"active:   {r['active']}\npriority: {PRIORITY[r.get('priority', 0)]}")
    print(f"tags:     {', '.join(r.get('tags') or []) or '—'}")
    upcoming = expand_rrule(r, datetime.now(LOCAL), datetime.now(LOCAL) + timedelta(days=28))
    print("next:     " + ", ".join(d.strftime("%a %d %b") for d in upcoming[:6]))
    if r.get("notes"):
        print(f"\n{r['notes']}")


def cmd_recurring_add(args):
    body = {"title": args.title, "rrule": args.rrule,
            "dtstart": to_utc(parse_when(args.dtstart) if args.dtstart else datetime.now(LOCAL)),
            "tags": tag_list(args.tags) or []}
    if args.notes:
        body["notes"] = args.notes
    if args.priority:
        body["priority"] = priority_val(args.priority)
    if args.bucket:
        body["bucket_id"] = bucket_id(args.bucket)
    if args.until:
        body["until"] = to_utc(parse_when(args.until, end_of_day=True))
    r = call("POST", "/admin/recurring-tasks", body)
    print(f"created {r['id']}  {r['rrule']}  {r['title']}")


def cmd_recurring_edit(args):
    r = resolve(args.ref, all_recurring(), "recurring task")
    body = {}
    for field, val in (("title", args.title), ("rrule", args.rrule), ("notes", args.notes)):
        if val is not None:
            body[field] = val
    if args.dtstart:
        body["dtstart"] = to_utc(parse_when(args.dtstart))
    if args.until:
        body["until"] = to_utc(parse_when(args.until, end_of_day=True))
    if args.priority:
        body["priority"] = priority_val(args.priority)
    if args.tags is not None:
        body["tags"] = tag_list(args.tags)
    if args.active is not None:
        body["active"] = args.active == "true"
    if not body:
        die("nothing to change")
    out = call("PUT", f"/admin/recurring-tasks/{r['id']}", body)
    print(f"updated {out['id']}  {out['rrule']}  {out['title']}")


def cmd_recurring_rm(args):
    r = resolve(args.ref, all_recurring(), "recurring task")
    if not args.yes:
        die(f"deleting the template drops its occurrences: {r['title']!r}. "
            f"Re-run with --yes, or pause it: recurring edit <ref> --active false")
    call("DELETE", f"/admin/recurring-tasks/{r['id']}")
    print(f"deleted {r['id']}  {r['title']}")


def cmd_recurring_complete(args):
    r = resolve(args.ref, all_recurring(), "recurring task")
    day = parse_when(args.date).date().isoformat() if args.date else date.today().isoformat()
    call("PUT", f"/admin/recurring-tasks/{r['id']}/occurrences/{day}/complete",
         {"done": not args.undo})
    print(("completed " if not args.undo else "reopened ") + f"{r['title']} for {day}")


# ── Calendar ──────────────────────────────────────────────────────────────
def events_between(start: datetime, end: datetime, tag: str | None = None) -> list[dict]:
    return call("GET", "/admin/calendar/events",
                params={"from": to_utc(start), "to": to_utc(end), "tag": tag}) or []


def event_line(e: dict) -> str:
    s, t = parse_utc(e["starts_at"]), parse_utc(e.get("ends_at"))
    when = fmt(s, day_only=True) + " (all day)" if e["all_day"] else \
        fmt(s) + (f"–{t.strftime('%H:%M')}" if t else "")
    line = f"{e['id'][:8]}  {when:<26} {e['title']}"
    if e.get("location"):
        line += f"  @ {e['location']}"
    if e.get("rrule"):
        line += f"  ↻ {e['rrule']}"
    if e.get("tags"):
        line += "  [" + ",".join(e["tags"]) + "]"
    return line


def cmd_cal_list(args):
    start, end = window(args)
    evs = events_between(start, end, args.tag)
    if args.json:
        return dump(evs)
    print(f"{fmt(start, day_only=True)} → {fmt(end, day_only=True)}")
    for e in sorted(evs, key=lambda e: e["starts_at"]):
        print("  " + event_line(e))
    print(f"\n{len(evs)} event(s)")


def cmd_cal_get(args):
    start = datetime.now(LOCAL) - timedelta(days=365)
    e = resolve(args.ref, events_between(start, start + timedelta(days=730)), "event")
    if args.json:
        return dump(e)
    print(f"{e['title']}\nid:          {e['id']}")
    print(f"starts:      {fmt(parse_utc(e['starts_at']))}")
    print(f"ends:        {fmt(parse_utc(e.get('ends_at')))}")
    print(f"all day:     {e['all_day']}\nlocation:    {e.get('location') or '—'}")
    print(f"rrule:       {e.get('rrule') or '—'}")
    print(f"tags:        {', '.join(e.get('tags') or []) or '—'}")
    if e.get("alerts"):
        print(f"alerts:      {json.dumps(e['alerts'])}")
    if e.get("description"):
        print(f"\n{e['description']}")


def cmd_cal_add(args):
    body = {"title": args.title, "starts_at": to_utc(parse_when(args.start)),
            "all_day": args.all_day, "tags": tag_list(args.tags) or []}
    if args.end:
        body["ends_at"] = to_utc(parse_when(args.end))
    for field, val in (("location", args.location), ("description", args.desc),
                       ("color", args.color), ("rrule", args.rrule)):
        if val:
            body[field] = val
    e = call("POST", "/admin/calendar/events", body)
    print(f"created {e['id']}  {event_line(e)}")


def cmd_cal_edit(args):
    start = datetime.now(LOCAL) - timedelta(days=365)
    e = resolve(args.ref, events_between(start, start + timedelta(days=730)), "event")
    body = {}
    if args.title:
        body["title"] = args.title
    if args.start:
        body["starts_at"] = to_utc(parse_when(args.start))
    if args.end:
        body["ends_at"] = to_utc(parse_when(args.end))
    if args.clear_end:
        body["ends_at"] = None
    if args.all_day is not None:
        body["all_day"] = args.all_day == "true"
    for field, val in (("location", args.location), ("description", args.desc), ("color", args.color)):
        if val is not None:
            body[field] = val
    if args.rrule is not None:
        body["rrule"] = args.rrule or None
    if args.tags is not None:
        body["tags"] = tag_list(args.tags)
    if not body:
        die("nothing to change")
    r = call("PUT", f"/admin/calendar/events/{e['id']}", body)
    print(f"updated {event_line(r)}")


def cmd_cal_rm(args):
    start = datetime.now(LOCAL) - timedelta(days=365)
    e = resolve(args.ref, events_between(start, start + timedelta(days=730)), "event")
    if not args.yes:
        die(f"deleting an event is permanent: {e['title']!r}. Re-run with --yes")
    call("DELETE", f"/admin/calendar/events/{e['id']}")
    print(f"deleted {e['id']}  {e['title']}")


# ── Agenda (merged) ───────────────────────────────────────────────────────
# The server's own /admin/agenda is broken (500 — its recurring query omits
# bucket_id, which RecurringTask requires), so this composes the same view
# client-side from /admin/tasks + /admin/calendar/events + /admin/recurring-tasks.
def cmd_agenda(args):
    start, end = window(args)
    tasks = [t for t in all_tasks({"done": "false"}) if t.get("due_at")]
    events = events_between(start, end, args.tag)
    recurring = [r for r in all_recurring() if r["active"]]
    done_occ = {(t["recurrence_id"], t["occurrence_date"])
                for t in all_tasks() if t.get("recurrence_id") and t["done"]}

    by_day: dict[date, list[tuple]] = {}
    now = datetime.now(LOCAL)
    for t in tasks:
        d = parse_utc(t["due_at"])
        if start <= d < end:
            by_day.setdefault(d.date(), []).append((d.time(), "task", t))
    overdue = [t for t in tasks if (d := parse_utc(t["due_at"])) and d < min(now, start)]
    for e in events:
        d = parse_utc(e["starts_at"])
        by_day.setdefault(max(d.date(), start.date()), []).append((d.time(), "event", e))
    for r in recurring:
        for day in expand_rrule(r, start, end):
            done = (r["id"], day.isoformat()) in done_occ
            by_day.setdefault(day, []).append((time(0, 0), "recurring", (r, done)))

    if args.json:
        return dump({"from": to_utc(start), "to": to_utc(end),
                     "tasks": tasks, "events": events, "recurring": recurring})

    if overdue:
        print(f"⚠  {len(overdue)} OVERDUE")
        bnames = bucket_names()
        for t in sorted(overdue, key=lambda t: t["due_at"]):
            print("   " + task_line(t, bnames))
        print()

    if not by_day:
        print(f"Nothing scheduled {fmt(start, day_only=True)} → {fmt(end, day_only=True)}")
        return
    for day in sorted(by_day):
        label = day.strftime("%A %d %B")
        if day == date.today():
            label += "  (today)"
        elif day == date.today() + timedelta(days=1):
            label += "  (tomorrow)"
        print(label)
        for _, kind, item in sorted(by_day[day], key=lambda x: x[0]):
            if kind == "event":
                s = parse_utc(item["starts_at"])
                when = "all day" if item["all_day"] else s.strftime("%H:%M")
                loc = f"  @ {item['location']}" if item.get("location") else ""
                print(f"  📅 {when:<8} {item['title']}{loc}")
            elif kind == "task":
                d = parse_utc(item["due_at"])
                prio = f"  !{PRIORITY[item['priority']]}" if item.get("priority") else ""
                print(f"  ☐  {d.strftime('%H:%M'):<8} {item['title']}{prio}")
            else:
                r, done = item
                print(f"  {'☑' if done else '↻'}  {'—':<8} {r['title']}")
        print()


# ── CLI ───────────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="agenda.py", description="Piuma Vault tasks, calendar and agenda")
    sub = p.add_subparsers(dest="group", required=True)

    def add_window(sp):
        sp.add_argument("--from", dest="frm", help="start (ISO or 'next monday')")
        sp.add_argument("--to", help="end (ISO or natural)")
        sp.add_argument("--days", type=int, help="window length from start (default 7)")

    # agenda / today / week
    for name, days in (("agenda", None), ("today", 1), ("week", 7), ("month", 30)):
        sp = sub.add_parser(name, help=f"merged tasks + events + recurring ({days or 'custom'} day view)")
        add_window(sp)
        sp.add_argument("--tag")
        sp.add_argument("--json", action="store_true")
        sp.set_defaults(func=cmd_agenda, _default_days=days)

    # tasks
    t = sub.add_parser("tasks", help="one-off tasks").add_subparsers(dest="cmd", required=True)
    sp = t.add_parser("list")
    sp.add_argument("--all", action="store_true", help="open + completed")
    sp.add_argument("--done", action="store_true", help="completed only")
    sp.add_argument("--overdue", action="store_true")
    sp.add_argument("--tag")
    sp.add_argument("--bucket")
    sp.add_argument("--no-bucket", action="store_true")
    sp.add_argument("--due-before")
    sp.add_argument("--due-after")
    sp.add_argument("--limit", type=int)
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_tasks_list)

    sp = t.add_parser("get"); sp.add_argument("ref"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_tasks_get)

    sp = t.add_parser("add"); sp.add_argument("title")
    sp.add_argument("--notes"); sp.add_argument("--due"); sp.add_argument("--priority")
    sp.add_argument("--bucket"); sp.add_argument("--tags")
    sp.set_defaults(func=cmd_tasks_add)

    sp = t.add_parser("edit"); sp.add_argument("ref")
    sp.add_argument("--title"); sp.add_argument("--notes"); sp.add_argument("--due")
    sp.add_argument("--clear-due", action="store_true"); sp.add_argument("--priority")
    sp.add_argument("--bucket"); sp.add_argument("--no-bucket", action="store_true")
    sp.add_argument("--tags")
    sp.set_defaults(func=cmd_tasks_edit)

    sp = t.add_parser("done"); sp.add_argument("ref"); sp.set_defaults(func=cmd_tasks_done)
    sp = t.add_parser("undone"); sp.add_argument("ref")
    sp.set_defaults(func=lambda a: cmd_tasks_done(a, done=False))
    sp = t.add_parser("rm"); sp.add_argument("ref"); sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_tasks_rm)
    sp = t.add_parser("buckets"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_buckets)

    # recurring
    r = sub.add_parser("recurring", help="recurring-task templates (RRULE)").add_subparsers(dest="cmd", required=True)
    sp = r.add_parser("list"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_recurring_list)
    sp = r.add_parser("get"); sp.add_argument("ref"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_recurring_get)
    sp = r.add_parser("add"); sp.add_argument("title")
    sp.add_argument("--rrule", required=True, help="e.g. FREQ=WEEKLY;BYDAY=MO,WE")
    sp.add_argument("--dtstart"); sp.add_argument("--until"); sp.add_argument("--notes")
    sp.add_argument("--priority"); sp.add_argument("--bucket"); sp.add_argument("--tags")
    sp.set_defaults(func=cmd_recurring_add)
    sp = r.add_parser("edit"); sp.add_argument("ref")
    sp.add_argument("--title"); sp.add_argument("--rrule"); sp.add_argument("--dtstart")
    sp.add_argument("--until"); sp.add_argument("--notes"); sp.add_argument("--priority")
    sp.add_argument("--tags"); sp.add_argument("--active", choices=["true", "false"])
    sp.set_defaults(func=cmd_recurring_edit)
    sp = r.add_parser("rm"); sp.add_argument("ref"); sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_recurring_rm)
    sp = r.add_parser("complete"); sp.add_argument("ref")
    sp.add_argument("--date", help="occurrence date (default today)")
    sp.add_argument("--undo", action="store_true")
    sp.set_defaults(func=cmd_recurring_complete)

    # calendar
    c = sub.add_parser("cal", help="calendar events").add_subparsers(dest="cmd", required=True)
    sp = c.add_parser("list"); add_window(sp); sp.add_argument("--tag")
    sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_cal_list)
    sp = c.add_parser("get"); sp.add_argument("ref"); sp.add_argument("--json", action="store_true")
    sp.set_defaults(func=cmd_cal_get)
    sp = c.add_parser("add"); sp.add_argument("title")
    sp.add_argument("--start", required=True); sp.add_argument("--end")
    sp.add_argument("--all-day", action="store_true"); sp.add_argument("--location")
    sp.add_argument("--desc"); sp.add_argument("--color"); sp.add_argument("--rrule")
    sp.add_argument("--tags")
    sp.set_defaults(func=cmd_cal_add)
    sp = c.add_parser("edit"); sp.add_argument("ref")
    sp.add_argument("--title"); sp.add_argument("--start"); sp.add_argument("--end")
    sp.add_argument("--clear-end", action="store_true")
    sp.add_argument("--all-day", choices=["true", "false"]); sp.add_argument("--location")
    sp.add_argument("--desc"); sp.add_argument("--color"); sp.add_argument("--rrule")
    sp.add_argument("--tags")
    sp.set_defaults(func=cmd_cal_edit)
    sp = c.add_parser("rm"); sp.add_argument("ref"); sp.add_argument("--yes", action="store_true")
    sp.set_defaults(func=cmd_cal_rm)
    return p


def main():
    global API, KEY
    args = build_parser().parse_args()
    if getattr(args, "_default_days", None) and not args.days and not args.to:
        args.days = args._default_days
    API, KEY = load_creds()
    args.func(args)


if __name__ == "__main__":
    main()

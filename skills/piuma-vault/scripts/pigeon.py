#!/usr/bin/env python3
"""Piuma Vault — the Inbox (Pigeon): WhatsApp, Instagram and Gmail in one place.

Companion to vault.sh (notes) and agenda.py (tasks, calendar). Same vault, same
x-api-key auth; the key needs inbox.read (and inbox.write to change anything).

Every command is one of the vault's Inbox tools, the ones Piuma has, run as the
key's user: `pigeon.py contacts query=elena` runs pigeon_contacts with
{"query": "elena"}. `pigeon.py tools` lists them; `pigeon.py tools <name>` shows
one's arguments. A value is JSON when it parses (numbers, true, [..], {..}),
else text; `-` reads it from stdin. Where a contact is expected (contact_id,
merge_id), `@slug` works too.
"""
from __future__ import annotations

import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

PREFIX = "pigeon_"


def die(msg: str, code: int = 1):
    print(f"pigeon: {msg}", file=sys.stderr)
    raise SystemExit(code)


# ── Credentials ───────────────────────────────────────────────────────────
# Same precedence as vault.sh and agenda.py: env → ~/.config/piuma-vault/env.
def load_creds() -> tuple[str, str]:
    url, key = os.environ.get("VAULT_URL"), os.environ.get("VAULT_API_KEY")
    path = Path(os.environ.get("VAULT_CONFIG", Path.home() / ".config/piuma-vault/env"))
    if path.is_file():
        for line in path.read_text().splitlines():
            m = re.match(r'^\s*(VAULT_URL|VAULT_API_KEY)\s*=\s*"?([^"#\s]+)"?', line)
            if m and m[1] == "VAULT_API_KEY" and not key:
                key = m[2]
            elif m and m[1] == "VAULT_URL" and not url:
                url = m[2]
    if not key:
        die("no API key. Set VAULT_API_KEY or write ~/.config/piuma-vault/env", 2)
    if not url:
        die("no vault URL. Set VAULT_URL or write ~/.config/piuma-vault/env", 2)
    return url.rstrip("/") + "/api/v1", key


API, KEY = "", ""


def call(method: str, path: str, body=None):
    data = json.dumps(body).encode() if body is not None else None
    # Cloudflare fronts the vault and 403s some default User-Agents: send our own.
    req = urllib.request.Request(API + path, data=data, method=method, headers={
        "x-api-key": KEY,
        "Content-Type": "application/json",
        "User-Agent": "piuma-vault-skill/1.0 (+claude-code)",
    })
    try:
        with urllib.request.urlopen(req, timeout=180) as r:
            raw = r.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        detail = e.read().decode(errors="replace")
        try:
            detail = json.loads(detail).get("error", detail)
        except ValueError:
            pass
        die(f"{e.code}: {detail}")
    except urllib.error.URLError as e:
        die(f"can't reach the vault: {e.reason}")


def tool_name(cmd: str) -> str:
    return cmd if cmd.startswith(PREFIX) else PREFIX + cmd.replace("-", "_")


def value(raw: str):
    if raw == "-":
        raw = sys.stdin.read().rstrip("\n")
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def contact_by_slug(slug: str) -> str:
    """@slug → the contact's id (exact slug match)."""
    s = slug.lstrip("@").lower()
    found = call("POST", "/admin/pigeon/tools/pigeon_contacts", {"query": "@" + s, "limit": 20})
    people = found.get("contacts", found) if isinstance(found, dict) else found
    for p in people or []:
        if (p.get("slug") or "").lstrip("@").lower() == s:
            return p["contact_id"]
    die(f"nobody is @{s}")


def show_tools(only: str | None):
    tools = call("GET", "/admin/pigeon/tools")["tools"]
    if only:
        name = tool_name(only)
        t = next((t for t in tools if t["name"] == name), None) or die(f"no tool {name}")
        print(f"{t['name'][len(PREFIX):]}{'  (changes things)' if t['writes'] else ''}\n")
        print(t["description"], "\n")
        props = t["parameters"].get("properties", {})
        required = set(t["parameters"].get("required", []))
        for k, p in props.items():
            kind = p.get("type", "string")
            desc = p.get("description", "")
            print(f"  {k}{' *' if k in required else ''}  ({kind})  {desc}")
        return
    for t in tools:
        short = t["name"][len(PREFIX):]
        first = re.split(r"(?<=[.:])\s", t["description"], maxsplit=1)[0]
        print(f"{short:<22} {'w' if t['writes'] else ' '}  {first}")


def main(argv: list[str]):
    global API, KEY
    if not argv or argv[0] in ("-h", "--help", "help"):
        print(__doc__.strip())
        print("\nUsage: pigeon.py tools [name] | pigeon.py <tool> [key=value ...] [--json '{...}']")
        return
    API, KEY = load_creds()
    if argv[0] == "tools":
        show_tools(argv[1] if len(argv) > 1 else None)
        return
    name, args, rest = tool_name(argv[0]), {}, argv[1:]
    while rest:
        a = rest.pop(0)
        if a == "--json":
            if not rest:
                die("--json needs an object")
            extra = value(rest.pop(0))
            if not isinstance(extra, dict):
                die("--json takes a JSON object")
            args.update(extra)
        elif "=" in a:
            k, v = a.split("=", 1)
            args[k] = value(v)
        else:
            die(f"'{a}': arguments are key=value (pigeon.py tools {argv[0]} lists them)")
    for k in ("contact_id", "merge_id"):
        if isinstance(args.get(k), str) and args[k].startswith("@"):
            args[k] = contact_by_slug(args[k])
    out = call("POST", f"/admin/pigeon/tools/{name}", args)
    print(json.dumps(out, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main(sys.argv[1:])

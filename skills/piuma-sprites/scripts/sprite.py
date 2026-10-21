#!/usr/bin/env python3
"""Piuma Vault sprite CLI: compose, preview and upload mascot sprites.

    sprite.py list
    sprite.py get KEY [-o FILE]
    sprite.py validate FILE
    sprite.py render FILE|KEY [-o OUT.png] [--scale N] [--gif]
    sprite.py push FILE [--key KEY] [--name NAME] [--activate]
    sprite.py activate KEY
    sprite.py delete KEY

FILE is JSON: either a bare definition, or {"key", "name", "definition"}.
Auth: x-api-key with the `sprites.manage` scope (or `admin_access`), read from
VAULT_URL / VAULT_API_KEY, else ~/.config/piuma-vault/env (same as vault.sh).
`render` and `validate` work offline on a FILE.
"""

import argparse
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path

CONFIG_FILE = Path(os.environ.get("VAULT_CONFIG", Path.home() / ".config/piuma-vault/env"))
LEG_ROWS = 2
# The in-app editor hard-codes this grid, so any other size breaks there.
WIDTH = 16
BODY_ROWS = 10
KEY_CHARS = set("abcdefghijklmnopqrstuvwxyz0123456789-_")


# ── Config + HTTP ────────────────────────────────────────────────────────────

def load_creds():
    url, key = os.environ.get("VAULT_URL"), os.environ.get("VAULT_API_KEY")
    if (not url or not key) and CONFIG_FILE.exists():
        for line in CONFIG_FILE.read_text().splitlines():
            k, _, v = line.partition("=")
            v = v.strip().strip('"').strip("'")
            if k.strip() == "VAULT_URL" and not url:
                url = v
            elif k.strip() == "VAULT_API_KEY" and not key:
                key = v
    if not url or not key:
        sys.exit(f"sprite: set VAULT_URL and VAULT_API_KEY, or put them in {CONFIG_FILE}")
    return url.rstrip("/") + "/api/v1", key


def api(method, path, body=None):
    base, key = load_creds()
    req = urllib.request.Request(
        base + path,
        method=method,
        data=None if body is None else json.dumps(body).encode(),
        headers={"x-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as res:
            raw = res.read()
            return json.loads(raw) if raw else None
    except urllib.error.HTTPError as e:
        msg = e.read().decode(errors="replace")
        try:
            msg = json.loads(msg).get("error", msg)
        except (ValueError, AttributeError):
            pass
        if e.code == 403:
            msg += " (the API key needs the sprites.manage scope)"
        sys.exit(f"sprite: HTTP {e.code} on {method} {path}: {msg}")


def list_sprites():
    data = api("GET", "/admin/sprites")
    return data if isinstance(data, list) else data.get("sprites", [])


# ── Definitions ──────────────────────────────────────────────────────────────

def read_file(path):
    doc = json.loads(Path(path).read_text())
    if "definition" in doc:
        return doc.get("key"), doc.get("name"), doc["definition"]
    return None, None, doc


def load_definition(src):
    """A FILE path, or the key of a sprite already in the vault."""
    if Path(src).exists():
        return read_file(src)
    for s in list_sprites():
        if s["key"] == src:
            return s["key"], s["name"], s["definition"]
    sys.exit(f"sprite: {src} is neither a file nor a sprite key")


def validate(d):
    """Same rules as the backend (SpriteDefinition::validate), plus warnings
    for codes that have no colour (they render transparent)."""
    errors, warnings = [], []
    palette = d.get("palette") or {}
    body = d.get("body") or []
    if not palette:
        errors.append("palette is empty")
    for code, colour in palette.items():
        if len(code) != 1:
            errors.append(f"palette code {code!r} must be one character")
        if not (isinstance(colour, str) and colour.startswith("#") and len(colour) in (4, 7)):
            errors.append(f"palette colour for {code!r} must be #rgb or #rrggbb, got {colour!r}")
    if not body:
        errors.append("body has no rows")
    elif len(body) != BODY_ROWS:
        errors.append(f"body must be {BODY_ROWS} rows (the editor assumes it), has {len(body)}")
    if "." in palette:
        errors.append("'.' must not be in the palette (it would paint every empty pixel)")
    if len(d.get("idleLegs") or []) != LEG_ROWS:
        errors.append("idleLegs must be exactly 2 rows")
    for name in ("walkLegs", "gallopLegs"):
        frames = d.get(name) or []
        if not frames:
            errors.append(f"{name} must have at least one frame")
        for i, f in enumerate(frames):
            if len(f) != LEG_ROWS:
                errors.append(f"{name}[{i}] must be exactly 2 rows")
    for name in ("walkFrameMs", "gallopFrameMs"):
        if not isinstance(d.get(name), int) or d.get(name, 0) <= 0:
            errors.append(f"{name} must be a positive integer")
    rows = list(body) + list(d.get("idleLegs") or [])
    for f in (d.get("walkLegs") or []) + (d.get("gallopLegs") or []):
        rows += list(f)
    if rows:
        width = len(rows[0])
        bad = sorted({len(r) for r in rows if len(r) != width})
        if bad:
            errors.append(f"all rows must be {width} wide; found widths {bad}")
        elif width != WIDTH:
            errors.append(f"rows must be {WIDTH} wide (the editor assumes it), are {width}")
        used = {c for r in rows for c in r if c != "."}
        missing = sorted(used - set(palette))
        if missing:
            warnings.append(f"codes with no palette colour render transparent: {missing}")
        unused = sorted(set(palette) - used)
        if unused:
            warnings.append(f"palette codes never used: {unused}")
        for name, frames in (("walkLegs", d.get("walkLegs") or []), ("gallopLegs", d.get("gallopLegs") or [])):
            for i, f in enumerate(frames):
                for p in floating_leg_pixels(body, f):
                    warnings.append(f"{name}[{i}]: leg pixel at row {p[0] + 11}, column {p[1]} touches nothing")
        for p in floating_leg_pixels(body, d.get("idleLegs") or []):
            warnings.append(f"idleLegs: leg pixel at row {p[0] + 11}, column {p[1]} touches nothing")
    return errors, warnings


def floating_leg_pixels(body, legs):
    """Leg pixels with no filled neighbour (8-way) in the last body row or the
    other leg row: they read as stray dirt instead of a foot."""
    if not body or len(legs) != LEG_ROWS:
        return []
    grid = [body[-1]] + list(legs)
    filled = lambda r, c: 0 <= r < len(grid) and 0 <= c < len(grid[r]) and grid[r][c] != "."
    out = []
    for r in (1, 2):
        for c, ch in enumerate(grid[r]):
            if ch == "." :
                continue
            if not any(filled(r + dr, c + dc) for dr in (-1, 0, 1) for dc in (-1, 0, 1) if (dr, dc) != (0, 0)):
                out.append((r - 1, c))
    return out


def poses(d):
    """[(label, rows)] for every pose: idle, each walk frame, each gallop frame."""
    body = list(d["body"])
    out = [("idle", body + list(d["idleLegs"]))]
    out += [(f"walk {i + 1}", body + list(f)) for i, f in enumerate(d["walkLegs"])]
    out += [(f"gallop {i + 1}", body + list(f)) for i, f in enumerate(d["gallopLegs"])]
    return out


# ── Rendering ────────────────────────────────────────────────────────────────

def hex_rgb(h):
    h = h.lstrip("#")
    if len(h) == 3:
        h = "".join(c * 2 for c in h)
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def draw_pose(img, rows, palette, x0, y0, scale, grid):
    from PIL import ImageDraw

    dr = ImageDraw.Draw(img)
    for y, row in enumerate(rows):
        for x, code in enumerate(row):
            colour = palette.get(code)
            if colour:
                dr.rectangle(
                    [x0 + x * scale, y0 + y * scale, x0 + (x + 1) * scale - 1, y0 + (y + 1) * scale - 1],
                    fill=hex_rgb(colour),
                )
    if grid:
        h, w = len(rows), len(rows[0])
        for x in range(w + 1):
            dr.line([x0 + x * scale, y0, x0 + x * scale, y0 + h * scale], fill=(60, 66, 80))
        for y in range(h + 1):
            col = (120, 90, 40) if y == h - LEG_ROWS else (60, 66, 80)
            dr.line([x0, y0 + y * scale, x0 + w * scale, y0 + y * scale], fill=col)


def render_sheet(d, out, scale):
    """Every pose in a row, on a dark and a light band (the vault has both
    themes), with a grid version of the idle pose on the left."""
    from PIL import Image, ImageDraw

    ps = poses(d)
    w, h = len(ps[0][1][0]) * scale, len(ps[0][1]) * scale
    pad, label_h = scale * 2, 18
    cols = len(ps) + 1
    band_h = h + pad * 2 + label_h
    img = Image.new("RGB", (cols * (w + pad) + pad, band_h * 2), (14, 15, 18))
    ImageDraw.Draw(img).rectangle([0, band_h, img.width, img.height], fill=(243, 239, 230))
    dr = ImageDraw.Draw(img)
    for band, (bg_text) in enumerate([(138, 147, 163), (107, 101, 90)]):
        y0 = band * band_h + pad
        x = pad
        draw_pose(img, ps[0][1], d["palette"], x, y0, scale, grid=True)
        dr.text((x, y0 + h + 4), "grid", fill=bg_text)
        for label, rows in ps:
            x += w + pad
            draw_pose(img, rows, d["palette"], x, y0, scale, grid=False)
            dr.text((x, y0 + h + 4), label, fill=bg_text)
    img.save(out)
    return out


def render_gif(d, out, scale):
    """Idle for a beat, then the walk cycle twice, then the gallop cycle three
    times, at the sprite's own frame timings, on the dark background."""
    from PIL import Image

    ps = poses(d)
    w, h = len(ps[0][1][0]) * scale, len(ps[0][1]) * scale
    pad = scale * 2
    walk = [r for l, r in ps if l.startswith("walk")]
    gallop = [r for l, r in ps if l.startswith("gallop")]
    seq = [(ps[0][1], 600)] + [(r, d["walkFrameMs"]) for r in walk * 2] + [(r, d["gallopFrameMs"]) for r in gallop * 3]
    frames, durations = [], []
    for rows, ms in seq:
        img = Image.new("RGB", (w + pad * 2, h + pad * 2), (14, 15, 18))
        draw_pose(img, rows, d["palette"], pad, pad, scale, grid=False)
        frames.append(img)
        durations.append(ms)
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0)
    return out


# ── Commands ─────────────────────────────────────────────────────────────────

def cmd_list(_):
    for s in list_sprites():
        d = s["definition"]
        tags = " ".join(t for t, on in (("active", s.get("active")), ("builtin", s.get("is_builtin"))) if on)
        size = f"{len(d['body'][0])}x{len(d['body']) + LEG_ROWS}"
        print(f"{s['key']:<16} {s['name']:<20} {size:<6} {tags}")


def cmd_get(a):
    key, name, d = load_definition(a.key)
    doc = json.dumps({"key": key, "name": name, "definition": d}, indent=2)
    if a.output:
        Path(a.output).write_text(doc + "\n")
        print(a.output)
    else:
        print(doc)


def report(d):
    errors, warnings = validate(d)
    for w in warnings:
        print(f"warning: {w}", file=sys.stderr)
    for e in errors:
        print(f"error: {e}", file=sys.stderr)
    return not errors


def cmd_validate(a):
    _, _, d = read_file(a.file)
    if not report(d):
        sys.exit(1)
    print(f"ok: {len(d['body'][0])}x{len(d['body']) + LEG_ROWS}, "
          f"{len(d['walkLegs'])} walk + {len(d['gallopLegs'])} gallop frames")


def cmd_render(a):
    key, _, d = load_definition(a.src)
    if not report(d):
        sys.exit(1)
    stem = a.output or f"/tmp/sprite-{key or Path(a.src).stem}.png"
    print(render_sheet(d, stem, a.scale))
    if a.gif:
        print(render_gif(d, str(Path(stem).with_suffix(".gif")), a.scale))


def cmd_push(a):
    fkey, fname, d = read_file(a.file)
    key, name = a.key or fkey, a.name or fname
    if not key or not name:
        sys.exit("sprite: push needs a key and a name (in the file or as --key/--name)")
    if not set(key) <= KEY_CHARS:
        sys.exit("sprite: key must be lowercase a-z, 0-9, - or _")
    if not report(d):
        sys.exit(1)
    exists = any(s["key"] == key for s in list_sprites())
    if exists:
        api("PUT", f"/admin/sprites/{key}", {"name": name, "definition": d})
        print(f"updated {key}")
    else:
        api("POST", "/admin/sprites", {"key": key, "name": name, "definition": d})
        print(f"created {key}")
    if a.activate:
        api("PUT", "/admin/sprites/active", {"key": key})
        print(f"active: {key}")


def cmd_activate(a):
    api("PUT", "/admin/sprites/active", {"key": a.key})
    print(f"active: {a.key}")


def cmd_delete(a):
    api("DELETE", f"/admin/sprites/{a.key}")
    print(f"deleted {a.key}")


def main():
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("list").set_defaults(fn=cmd_list)
    g = sub.add_parser("get")
    g.add_argument("key")
    g.add_argument("-o", "--output")
    g.set_defaults(fn=cmd_get)
    v = sub.add_parser("validate")
    v.add_argument("file")
    v.set_defaults(fn=cmd_validate)
    r = sub.add_parser("render")
    r.add_argument("src", help="a definition FILE or a sprite key in the vault")
    r.add_argument("-o", "--output")
    r.add_argument("--scale", type=int, default=16)
    r.add_argument("--gif", action="store_true", help="also write an animated GIF next to the PNG")
    r.set_defaults(fn=cmd_render)
    u = sub.add_parser("push")
    u.add_argument("file")
    u.add_argument("--key")
    u.add_argument("--name")
    u.add_argument("--activate", action="store_true")
    u.set_defaults(fn=cmd_push)
    ac = sub.add_parser("activate")
    ac.add_argument("key")
    ac.set_defaults(fn=cmd_activate)
    dl = sub.add_parser("delete")
    dl.add_argument("key")
    dl.set_defaults(fn=cmd_delete)
    a = p.parse_args()
    a.fn(a)


if __name__ == "__main__":
    main()

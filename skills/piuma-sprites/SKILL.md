---
name: piuma-sprites
description: Design, preview and upload the pixel-art mascot sprites in Piuma Vault (the little animal on the loader, header, chat runner and recorder). Use when the user asks to make, draw, redesign, fix, recolour, animate, import, activate or delete a sprite or mascot, or asks how a sprite looks.
---

# Piuma Vault sprites

A sprite is a small pixel grid with an idle pose, a walk cycle and a gallop cycle.
The vault stores it as JSON and draws it everywhere the mascot appears. You compose
the JSON here, render it to a PNG to look at it, fix it, and push it to the vault.

```
scripts/sprite.py list                       # sprites in the vault (key, name, size, active)
scripts/sprite.py get KEY -o FILE            # download one as an editable file
scripts/sprite.py validate FILE              # same checks as the backend, plus warnings
scripts/sprite.py render FILE|KEY --gif      # PNG sheet (+ GIF) in /tmp; then Read the PNG
scripts/sprite.py push FILE [--activate]     # create, or update if the key exists
scripts/sprite.py activate KEY               # make it the vault's mascot
scripts/sprite.py delete KEY
```

Auth is the same as the `piuma-vault` skill: `VAULT_URL` and `VAULT_API_KEY` from the
environment or `~/.config/piuma-vault/env`. The key needs the **`sprites.manage`** scope
(or `admin_access`); add it to the key on the API Keys page. A 403 means the scope is
missing. `render` and `validate` work offline on a file.

## The format

```json
{
  "key": "fox",
  "name": "Fox",
  "definition": {
    "palette": { "B": "#d9772b", "W": "#f5efe6", "E": "#1b1b1b", "T": "#ff7a9a" },
    "body": [ "10 strings, all the same width" ],
    "idleLegs":  [ "row 11", "row 12" ],
    "walkLegs":  [ [ "row 11", "row 12" ], [ "...", "..." ] ],
    "walkFrameMs": 120,
    "gallopLegs": [ [ "row 11", "row 12" ], [ "...", "..." ] ],
    "gallopFrameMs": 140
  }
}
```

* Each character in a row is one pixel. `.` (or any code missing from the palette) is
  transparent. Palette codes are single characters, colours are `#rrggbb`.
* `body` rows are shared by every pose. Only the two leg rows change per frame, so all
  motion lives in rows 11 and 12.
* Every row in body and every leg frame must be the same width. The built-ins are
  **16 wide and 12 tall** (10 body rows + 2 leg rows). Stick to that: it is what the
  editor, the loader and the header are sized for.
* Keys are lowercase, short and unique (`fox`, `owl`, `bubu`). Pushing an existing key
  updates that sprite.

## Workflow

1. Start from `examples/fox.json` (follows every rule below) or a built-in
   (`sprite.py get piuma -o /tmp/sprites/new.json`), then edit. Keep working files in
   `/tmp/sprites/`.
2. Write the body first, then idle legs, then the walk and gallop frames.
3. `sprite.py render /tmp/sprites/fox.json --gif` and **Read the PNG**. It shows a grid
   view (the orange line marks where the legs start) and every pose, on a dark and a
   light background, because the vault has both themes.
4. Fix what looks wrong and render again. Show the user the PNG (and the GIF path)
   before pushing; ask before `--activate` or `delete`, since those change what
   everyone sees.
5. `sprite.py push /tmp/sprites/fox.json`, then `--activate` or `activate fox` once the
   user is happy.

## Design guide

These come from what goes wrong in the built-ins and in AI-generated attempts.

* **Face left.** The vault never flips sprites. The built-ins have the head on the left
  and the tail on the right, and the walk animation assumes it.
* **Read at 1x.** The sprite is often shown at 2 to 4 pixels per cell. Each feature needs
  at least one full pixel and a contrasting neighbour: two eye pixels, a nose, maybe a
  collar or a belly patch. Leave a transparent column at each side and keep the top row
  mostly empty so the silhouette has air.
* **Work on dark and light.** Near-black only works next to a lighter colour. Piuma's
  ears are `#0d0d0d` and vanish on the dark theme; give dark details a lighter edge, or
  use a dark brown or navy instead of black.
* **Few colours.** 4 to 7 palette entries: a main body colour, a shade, a light belly or
  face, the eyes, one accent (collar, cheeks, tongue). More than that turns to noise at
  this size.
* **Legs stay attached.** Every leg pixel in rows 11 and 12 must touch the body row above
  it or another leg pixel. A pixel floating on its own reads as dirt, not a foot (the
  built-in gallop frames have this problem).
* **Walk = 4 frames, gallop = 2.** Walk: alternate front and back pairs (legs apart,
  together, apart the other way, together). Gallop: one frame with the legs stretched
  out front and back, one with them gathered under the body. Keep the same number of
  leg pixels between frames so the body does not seem to shrink.
* **Timing.** `walkFrameMs` 110 to 140 and `gallopFrameMs` 120 to 160 look right; lower
  is frantic.

## When it fails

* `all rows must be N wide`: one row is a character short or long. `validate` lists the
  widths it found.
* `codes with no palette colour`: a letter in a row has no colour, so it renders as a
  hole. Add it to the palette or change the letter.
* HTTP 403 `Requires sprites.manage`: the API key lacks the scope.
* Built-in sprites can be edited but are reseeded only when the table is empty, so an
  edit to `piuma` sticks.

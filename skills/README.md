# Claude Code skills

Skills for this project, kept in the repo so they stay versioned alongside the code
they describe.

| Skill | What it covers |
|---|---|
| [`piuma-vault`](piuma-vault/SKILL.md) | Driving the running vault over its admin API — notes, tasks, recurring tasks, buckets, calendar events and the merged agenda — via `scripts/vault.sh` and `scripts/agenda.py`. |
| [`piuma-sprites`](piuma-sprites/SKILL.md) | Designing, previewing and uploading the pixel mascot sprites via `scripts/sprite.py` (needs an API key with the `sprites.manage` scope). |
| [`vault-deploy`](vault-deploy/SKILL.md) | Developing and shipping the vault itself: checking a change, deploying to k3s (images, tags, rollout, health), production's database, logs and hand migrations. |

**In a checkout there is nothing to install.** each `.claude/skills/<name>` is a symlink
committed alongside these files, pointing back at `skills/<name>`, so Claude Code
picks the skill up in this project as soon as you clone or pull — no setup step to forget
on a second machine.

To reach the skill from *outside* this repo, link it into your user-wide skills directory.
Symlink, never copy — a copy silently drifts from the API it describes. See *Installing
this skill* at the bottom of the skill's SKILL.md.

```sh
ln -s "$PWD/skills/piuma-vault" ~/.claude/skills/piuma-vault   # from a checkout
```

No credentials are committed here; the scripts resolve an API key from `VAULT_API_KEY`,
then `~/.config/piuma-vault/env`, then the phone app's `.env` (`~/docker/piuma-vault-mobile`).

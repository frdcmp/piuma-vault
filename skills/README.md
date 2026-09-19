# Claude Code skills

Skills for this project, kept in the repo so they stay versioned alongside the code
they describe.

| Skill | What it covers |
|---|---|
| [`piuma-vault`](piuma-vault/SKILL.md) | Driving the running vault over its admin API — notes, tasks, recurring tasks, buckets, calendar events and the merged agenda — via `scripts/vault.sh` and `scripts/agenda.py`. |

**In a checkout there is nothing to install.** `.claude/skills/piuma-vault` is a symlink
committed alongside these files, pointing back at `skills/piuma-vault`, so Claude Code
picks the skill up in this project as soon as you clone or pull — no setup step to forget
on a second machine.

To reach the skill from *outside* this repo, link it into your user-wide skills directory.
Symlink, never copy — a copy silently drifts from the API it describes. See *Installing
this skill* at the bottom of the skill's SKILL.md.

```sh
ln -s "$PWD/skills/piuma-vault" ~/.claude/skills/piuma-vault   # from a checkout
```

No credentials are committed here; the scripts resolve an API key from `VAULT_API_KEY`,
then `~/.config/piuma-vault/env`, then `piuma-vault-mobile/.env`.

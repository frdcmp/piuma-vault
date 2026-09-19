# Claude Code skills

Skills for this project, kept in the repo so they stay versioned alongside the code
they describe.

| Skill | What it covers |
|---|---|
| [`piuma-vault`](piuma-vault/SKILL.md) | Driving the running vault over its admin API — notes, tasks, recurring tasks, buckets, calendar events and the merged agenda — via `scripts/vault.sh` and `scripts/agenda.py`. |

Install by symlinking, never by copying — a copy silently drifts from the API it
describes. See *Installing this skill* at the bottom of the skill's SKILL.md.

```sh
ln -s "$PWD/skills/piuma-vault" ~/.claude/skills/piuma-vault   # from a checkout
```

No credentials are committed here; the scripts resolve an API key from `VAULT_API_KEY`,
then `~/.config/piuma-vault/env`, then `piuma-vault-mobile/.env`.

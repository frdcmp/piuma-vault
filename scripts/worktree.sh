#!/usr/bin/env bash
set -euo pipefail

# ═══════════════════════════════════════════════════════════════════════════════
# A worktree for a piece of work, when the user asks for one (CLAUDE.md, "Worktrees only when asked").
#
#   scripts/worktree.sh new <name> [--branch <b>] [--from <ref>]
#       → .worktrees/<name> on a new branch feat/<name> (or <b>), from main (or <ref>); an existing
#         branch is checked out instead. Copies .env and frontend/node_modules (reflink on btrfs,
#         so instant).
#   scripts/worktree.sh list
#   scripts/worktree.sh remove <name> [--force]
#       → removes the worktree. The branch stays. Uncommitted changes make git refuse unless --force.
#
# A worktree has no compose project of its own: its frontend dev server talks to the main
# checkout's nginx/backend (`cd .worktrees/<name>/frontend && bun run dev --port 3001`).
# .worktrees/ is ignored through .git/info/exclude, like the crm repo.
# ═══════════════════════════════════════════════════════════════════════════════

die() { printf '✗ %s\n' "$*" >&2; exit 1; }

# the main checkout, also when run from inside a worktree
ROOT=$(cd "$(git rev-parse --git-common-dir)/.." && pwd -P)
WT_DIR="$ROOT/.worktrees"

ignore_worktrees() {
  local ex
  ex="$(git -C "$ROOT" rev-parse --git-common-dir)/info/exclude"
  grep -qx '.worktrees/' "$ex" 2>/dev/null || echo '.worktrees/' >>"$ex"
}

cmd_new() {
  local name="" branch="" from=main
  while [ $# -gt 0 ]; do
    case $1 in
      --branch) branch=$2; shift 2 ;;
      --from) from=$2; shift 2 ;;
      -*) die "unknown flag $1" ;;
      *) [ -z "$name" ] || die "one name only"; name=$1; shift ;;
    esac
  done
  [ -n "$name" ] || die "usage: $0 new <name> [--branch <b>] [--from <ref>]"
  [[ $name =~ ^[a-z0-9][a-z0-9-]*$ ]] || die "name: lowercase letters, digits and dashes ($name)"
  branch=${branch:-feat/$name}
  local dir="$WT_DIR/$name"
  [ -e "$dir" ] && die "$dir exists already"

  ignore_worktrees
  mkdir -p "$WT_DIR"
  if git -C "$ROOT" show-ref --verify --quiet "refs/heads/$branch"; then
    git -C "$ROOT" worktree add "$dir" "$branch"
  else
    git -C "$ROOT" worktree add "$dir" -b "$branch" "$from"
  fi

  if [ -f "$ROOT/.env" ]; then cp "$ROOT/.env" "$dir/.env"; else echo "! no .env in the main checkout to copy"; fi

  if [ -d "$ROOT/frontend/node_modules" ]; then
    cp -a --reflink=auto "$ROOT/frontend/node_modules" "$dir/frontend/node_modules"
  else
    echo "! no frontend/node_modules in the main checkout: run bun install in $dir/frontend"
  fi

  cat <<EOF

✓ worktree $name
  path     $dir
  branch   $branch (from $(git -C "$dir" rev-parse --short HEAD))
  dev      cd $dir/frontend && bun run dev --port 3001   # proxies /api to the main checkout's nginx
EOF
}

cmd_list() {
  git -C "$ROOT" worktree list
}

cmd_remove() {
  local name="" force=""
  while [ $# -gt 0 ]; do
    case $1 in
      --force) force=--force; shift ;;
      -*) die "unknown flag $1" ;;
      *) name=$1; shift ;;
    esac
  done
  [ -n "$name" ] || die "usage: $0 remove <name> [--force]"
  local dir="$WT_DIR/$name"
  [ -d "$dir" ] || die "no worktree $dir"
  # node_modules and .env are untracked: git would refuse over them, they are ours to drop
  rm -rf "$dir/frontend/node_modules" "$dir/.env"
  git -C "$ROOT" worktree remove $force "$dir" || die "git refused (uncommitted changes?): commit them, or rerun with --force to drop them"
  echo "✓ removed $dir (its branch is kept)"
}

case "${1:-}" in
  new) shift; cmd_new "$@" ;;
  list) shift; cmd_list ;;
  remove) shift; cmd_remove "$@" ;;
  *) die "usage: $0 new <name> [--branch <b>] [--from <ref>] | list | remove <name> [--force]" ;;
esac

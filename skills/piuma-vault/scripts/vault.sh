#!/usr/bin/env bash
# Piuma Vault notes CLI — thin wrapper over /api/v1/admin/notes.
# Auth: x-api-key header. See `vault.sh help`.
set -uo pipefail

# ── Config ────────────────────────────────────────────────────────────────
CONFIG_FILE="${VAULT_CONFIG:-$HOME/.config/piuma-vault/env}"
MOBILE_ENV="$HOME/docker/piuma-vault/piuma-vault-mobile/.env"

load_creds() {
  # Precedence: exported env > ~/.config/piuma-vault/env > mobile .env
  if [ -z "${VAULT_API_KEY:-}" ] && [ -f "$CONFIG_FILE" ]; then
    # shellcheck disable=SC1090
    set -a; . "$CONFIG_FILE"; set +a
  fi
  if [ -z "${VAULT_API_KEY:-}" ] && [ -f "$MOBILE_ENV" ]; then
    VAULT_API_KEY=$(sed -n 's/^VAULT_API_KEY=//p' "$MOBILE_ENV" | tr -d '"' | head -1)
    [ -z "${VAULT_URL:-}" ] && VAULT_URL=$(sed -n 's/^SITE_URL=//p' "$MOBILE_ENV" | tr -d '"' | head -1)
  fi
  VAULT_URL="${VAULT_URL:-}"; VAULT_URL="${VAULT_URL%/}"
  if [ -z "$VAULT_URL" ]; then
    echo "vault: no vault URL. Set VAULT_URL, or put VAULT_URL= in $CONFIG_FILE" >&2
    exit 2
  fi
  if [ -z "${VAULT_API_KEY:-}" ]; then
    echo "vault: no API key. Set VAULT_API_KEY, or put VAULT_URL/VAULT_API_KEY in $CONFIG_FILE" >&2
    exit 2
  fi
  API="$VAULT_URL/api/v1"
}

die() { echo "vault: $*" >&2; exit 1; }

# ── HTTP ──────────────────────────────────────────────────────────────────
# api METHOD PATH [JSON_BODY]
api() {
  local method="$1" path="$2" body="${3:-}" code out tmp
  tmp=$(mktemp)
  if [ -n "$body" ]; then
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-api-key: $VAULT_API_KEY" -H 'Content-Type: application/json' \
      --data-binary "$body")
  else
    code=$(curl -sS -o "$tmp" -w '%{http_code}' -X "$method" "$API$path" \
      -H "x-api-key: $VAULT_API_KEY")
  fi
  out=$(cat "$tmp"); rm -f "$tmp"
  if [ "${code:0:1}" != "2" ]; then
    echo "HTTP $code from $method $path" >&2
    echo "$out" | jq -r '.error // .' 2>/dev/null >&2 || echo "$out" >&2
    return 1
  fi
  printf '%s' "$out"
}

urlenc() { jq -rn --arg v "$1" '$v|@uri'; }

# ── Helpers ───────────────────────────────────────────────────────────────
is_uuid() { [[ "$1" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; }

# Accept a UUID or a title. Titles are matched against the *title text* of the
# search hits, never the top hit: hybrid search always returns something (the
# vector and trigram pools never come back empty), so trusting rank alone would
# happily edit an unrelated note. Callers must use `id=$(resolve_id x) || exit 1`
# — this runs in a subshell, so `exit` here would not stop them.
resolve_id() {
  local ref="$1" res cands n exact
  if is_uuid "$ref"; then printf '%s' "$ref"; return 0; fi
  res=$(api GET "/admin/notes?limit=50&search=$(urlenc "$ref")") || return 1
  cands=$(printf '%s' "$res" | jq -c --arg t "$ref" \
    '[.data[]|select(.title|ascii_downcase|contains($t|ascii_downcase))]')
  n=$(printf '%s' "$cands" | jq 'length')
  if [ "$n" = "0" ]; then
    echo "vault: no note title matches '$ref' — try: vault.sh search \"$ref\"" >&2
    return 1
  fi
  # An exact (case-insensitive) title wins over its own longer variants.
  exact=$(printf '%s' "$cands" | jq -r --arg t "$ref" \
    '[.[]|select((.title|ascii_downcase)==($t|ascii_downcase))]|.[0].id // empty')
  if [ -n "$exact" ]; then printf '%s' "$exact"; return 0; fi
  if [ "$n" != "1" ]; then
    { echo "'$ref' is ambiguous — $n title matches:"
      printf '%s' "$cands" | jq -r '.[]|"  \(.id)  \(.folder // "/")  \(.title)"'; } >&2
    return 1
  fi
  printf '%s' "$cands" | jq -r '.[0].id'
}

fmt_list() {  # stdin: NoteListResponse
  jq -r '"\(.total) note(s), showing \(.data|length) (offset \(.offset))",
         (.data[] | "\(.id)  \((.updated_at // "")[0:10])  \(.folder // "/")  \(.title)" +
                    (if (.tags|length)>0 then "  [\(.tags|join(","))]" else "" end) +
                    (if .headline then "\n    … \(.headline|gsub("<b>";"**")|gsub("</b>";"**")|gsub("\n";" ")) …" else "" end))'
}

# Collect note body from --content / --file / stdin
read_body_arg() {  # echoes content or empty
  if [ -n "${OPT_CONTENT+x}" ]; then printf '%s' "$OPT_CONTENT"
  elif [ -n "${OPT_FILE:-}" ]; then cat "$OPT_FILE"
  elif [ ! -t 0 ]; then cat
  fi
}

tags_json() { jq -cRn --arg t "$1" '($t|split(",")|map(gsub("^\\s+|\\s+$";""))|map(select(length>0)))'; }

# ── Commands ──────────────────────────────────────────────────────────────
cmd_list() {
  local q="limit=${OPT_LIMIT:-50}&offset=${OPT_OFFSET:-0}"
  [ -n "${OPT_FOLDER:-}" ] && q="$q&folder=$(urlenc "$OPT_FOLDER")"
  [ -n "${OPT_TAG:-}" ] && q="$q&tag=$(urlenc "$OPT_TAG")"
  local r; r=$(api GET "/admin/notes?$q") || exit 1
  if [ -n "${OPT_JSON:-}" ]; then printf '%s\n' "$r" | jq .; else printf '%s' "$r" | fmt_list; fi
}

cmd_search() {
  [ $# -ge 1 ] || die "search needs a query"
  local q="limit=${OPT_LIMIT:-20}&offset=${OPT_OFFSET:-0}&search=$(urlenc "$1")"
  [ -n "${OPT_FOLDER:-}" ] && q="$q&folder=$(urlenc "$OPT_FOLDER")"
  [ -n "${OPT_TAG:-}" ] && q="$q&tag=$(urlenc "$OPT_TAG")"
  local r; r=$(api GET "/admin/notes?$q") || exit 1
  if [ -n "${OPT_JSON:-}" ]; then printf '%s\n' "$r" | jq .; else printf '%s' "$r" | fmt_list; fi
}

cmd_get() {
  [ $# -ge 1 ] || die "get needs an id or title"
  local id r; id=$(resolve_id "$1") || exit 1; r=$(api GET "/admin/notes/$id") || exit 1
  if [ -n "${OPT_JSON:-}" ]; then printf '%s\n' "$r" | jq .
  elif [ -n "${OPT_RAW:-}" ]; then printf '%s' "$r" | jq -r '.content'
  else printf '%s' "$r" | jq -r '"# \(.title)\nid:      \(.id)\nfolder:  \(.folder // "/")\ntags:    \(.tags|join(", "))\nupdated: \(.updated_at)\n\n---\n\n\(.content)"'
  fi
}

cmd_new() {
  [ $# -ge 1 ] || die "new needs a title"
  local title="$1" content; content=$(read_body_arg)
  local payload
  payload=$(jq -cn --arg t "$title" --arg c "$content" --arg f "${OPT_FOLDER:-/}" \
    --argjson tags "$(tags_json "${OPT_TAGS:-}")" \
    '{title:$t, content:$c, folder:$f, tags:$tags}')
  local r; r=$(api POST "/admin/notes" "$payload") || exit 1
  printf '%s' "$r" | jq -r '"created \(.id)  \(.folder)  \(.title)"'
}

cmd_edit() {
  [ $# -ge 1 ] || die "edit needs an id or title"
  local id; id=$(resolve_id "$1") || exit 1; shift
  local content; content=$(read_body_arg)
  local payload='{}'
  [ -n "${OPT_TITLE:-}" ] && payload=$(printf '%s' "$payload" | jq -c --arg v "$OPT_TITLE" '.title=$v')
  [ -n "${OPT_FOLDER:-}" ] && payload=$(printf '%s' "$payload" | jq -c --arg v "$OPT_FOLDER" '.folder=$v')
  [ -n "${OPT_TAGS+x}" ] && payload=$(printf '%s' "$payload" | jq -c --argjson v "$(tags_json "${OPT_TAGS:-}")" '.tags=$v')
  [ -n "$content" ] && payload=$(printf '%s' "$payload" | jq -c --arg v "$content" '.content=$v')
  [ "$payload" = "{}" ] && die "edit: nothing to change (pass --title/--folder/--tags and/or new content)"
  local r; r=$(api PUT "/admin/notes/$id" "$payload") || exit 1
  printf '%s' "$r" | jq -r '"updated \(.id)  \(.folder // "/")  \(.title)"'
}

cmd_append() {
  [ $# -ge 1 ] || die "append needs an id or title"
  local id; id=$(resolve_id "$1") || exit 1
  local add; add=$(read_body_arg)
  [ -n "$add" ] || die "append: nothing to add (use --content, --file, or stdin)"
  local cur; cur=$(api GET "/admin/notes/$id") || exit 1
  local payload
  payload=$(printf '%s' "$cur" | jq -c --arg add "$add" '{content: (.content + "\n\n" + $add)}')
  api PUT "/admin/notes/$id" "$payload" | jq -r '"appended to \(.id)  \(.title)"'
}

cmd_mv() {
  [ $# -ge 2 ] || die "mv needs <id|title> <\/new\/folder>"
  local id; id=$(resolve_id "$1") || exit 1
  case "$2" in /*) ;; *) die "folder must start with /";; esac
  api PUT "/admin/notes/$id" "$(jq -cn --arg f "$2" '{folder:$f}')" \
    | jq -r '"moved \(.id) → \(.folder)  (\(.title))"'
}

cmd_mvfolder() {
  [ $# -ge 2 ] || die "mvfolder needs <\/from> <\/to>"
  api PUT "/admin/notes/folders/rename" "$(jq -cn --arg a "$1" --arg b "$2" '{from:$a,to:$b}')" \
    | jq -r '"\(.from) → \(.to): \(.updated) note(s) moved"'
}

cmd_rm() {
  [ $# -ge 1 ] || die "rm needs an id or title"
  local id; id=$(resolve_id "$1") || exit 1
  api DELETE "/admin/notes/$id" | jq -r '"trashed \(.id)  (restore with: vault.sh restore \(.id))"'
}

cmd_restore() {
  [ $# -ge 1 ] || die "restore needs a note id (see: vault.sh trash)"
  is_uuid "$1" || die "restore needs the UUID from \`vault.sh trash\` (search can't see trashed notes)"
  api PUT "/admin/notes/$1/restore" | jq -r '"restored \(.id)"'
}

cmd_purge() {
  [ $# -ge 1 ] || die "purge needs a note id"
  [ -n "${OPT_YES:-}" ] || die "purge is permanent (row + S3 attachments). Re-run with --yes"
  local id; id=$(resolve_id "$1") || exit 1
  api DELETE "/admin/notes/$id/permanent" | jq -r '"permanently deleted \(.id)"'
}

cmd_trash() {
  local r; r=$(api GET "/admin/notes/trash?limit=${OPT_LIMIT:-200}") || exit 1
  if [ -n "${OPT_JSON:-}" ]; then printf '%s\n' "$r" | jq .; else
    printf '%s' "$r" | jq -r '"\(.total) trashed note(s)",
      (.data[]|"\(.id)  trashed \((.deleted_at // "")[0:16])  \(.folder // "/")  \(.title)")'
  fi
}

cmd_empty_trash() {
  [ -n "${OPT_YES:-}" ] || die "empty-trash permanently deletes every trashed note. Re-run with --yes"
  api DELETE "/admin/notes/trash" | jq -r '"\(.message) (\(.deleted_count))"'
}

cmd_folders() { api GET "/admin/notes/folders" | jq -r '.[]'; }

cmd_findfolder() {
  [ $# -ge 1 ] || die "findfolder needs a query"
  api GET "/admin/notes/folders/search?q=$(urlenc "$1")&limit=${OPT_LIMIT:-20}" \
    | jq -r '.[]|"\(.path)  (\(.file_count) note(s))"'
}

cmd_browse() {
  local p="${1:-/}"
  local r; r=$(api GET "/admin/notes/browse?path=$(urlenc "$p")") || exit 1
  if [ -n "${OPT_JSON:-}" ]; then printf '%s\n' "$r" | jq .; else
    printf '%s' "$r" | jq -r '"path: \(.path)",
      (.subfolders[]|"  [dir]  \(.)"),
      (.files[]|"  \(.id)  \((.updated_at // "")[0:10])  \(.title)")'
  fi
}

cmd_tags() { api GET "/admin/notes/tags" | jq -r '.[]'; }

cmd_versions() {
  [ $# -ge 1 ] || die "versions needs an id or title"
  local id; id=$(resolve_id "$1") || exit 1
  if [ -n "${OPT_GET:-}" ]; then
    local v; v=$(api GET "/admin/notes/$id/versions/$OPT_GET") || exit 1
    if [ -n "${OPT_JSON:-}" ]; then printf '%s\n' "$v" | jq .
    else printf '%s' "$v" | jq -r '"# \(.title)  (version \(.id), \(.source), \(.created_at))\nfolder: \(.folder // "/")   tags: \(.tags|join(", "))\n\n---\n\n\(.content)"'; fi
  elif [ -n "${OPT_RESTORE:-}" ]; then
    api POST "/admin/notes/$id/versions/$OPT_RESTORE/restore" \
      | jq -r --arg v "$OPT_RESTORE" '"restored version \($v) into \(.id)  \(.title)"'
  else
    api GET "/admin/notes/$id/versions" \
      | jq -r '.data[]|"\(.id)  \(.created_at)  \(.source)  \(.content_chars)ch  \(.folder // "/")  \(.title)"'
  fi
}

usage() {
  cat <<'EOF'
vault.sh — Piuma Vault notes ($VAULT_URL/api/v1/admin/notes)

READ
  list [--folder F] [--tag T] [--limit N] [--offset N] [--json]
  search "query" [--folder F] [--tag T] [--limit N] [--json]   hybrid FTS+vector+trigram
  get <id|title> [--raw|--json]                                --raw = content only
  browse [/path] [--json]        folders        findfolder "q"        tags

WRITE
  new "Title" [--folder /f] [--tags a,b] [--content C | --file F | < stdin]
  edit <id|title> [--title T] [--folder /f] [--tags a,b] [--content C | --file F | < stdin]
  append <id|title> [--content C | --file F | < stdin]
  mv <id|title> /new/folder                    move one note
  mvfolder /from /to                           bulk-move a folder + its subfolders

DELETE
  rm <id|title>                soft delete (goes to trash)
  trash [--json]               list trashed notes
  restore <uuid>               un-trash
  purge <id|title> --yes       permanent (also deletes S3 attachments)
  empty-trash --yes            permanent, all trashed notes

HISTORY
  versions <id|title> [--get <vid>] [--restore <vid>]

Notes are markdown. Tags are normalized lowercase-with-hyphens. Folder paths
start with "/" and are just a string on each note (no folder table).
Auth: VAULT_API_KEY env, else ~/.config/piuma-vault/env, else the mobile .env.
Tasks + calendar live in the sibling agenda.py.
EOF
}

# ── Arg parsing ───────────────────────────────────────────────────────────
[ $# -ge 1 ] || { usage; exit 1; }
CMD="$1"; shift
POS=()
while [ $# -gt 0 ]; do
  case "$1" in
    --folder)  OPT_FOLDER="$2"; shift 2;;
    --tag)     OPT_TAG="$2"; shift 2;;
    --tags)    OPT_TAGS="$2"; shift 2;;
    --title)   OPT_TITLE="$2"; shift 2;;
    --content) OPT_CONTENT="$2"; shift 2;;
    --file)    OPT_FILE="$2"; shift 2;;
    --limit)   OPT_LIMIT="$2"; shift 2;;
    --offset)  OPT_OFFSET="$2"; shift 2;;
    --get)     OPT_GET="$2"; shift 2;;
    --restore) OPT_RESTORE="$2"; shift 2;;
    --json)    OPT_JSON=1; shift;;
    --raw)     OPT_RAW=1; shift;;
    --yes|-y)  OPT_YES=1; shift;;
    -h|--help) usage; exit 0;;
    --) shift; while [ $# -gt 0 ]; do POS+=("$1"); shift; done;;
    -*) die "unknown flag $1";;
    *)  POS+=("$1"); shift;;
  esac
done
set -- ${POS+"${POS[@]}"}

case "$CMD" in
  help|-h|--help) usage; exit 0;;
esac
command -v jq >/dev/null || die "jq is required"
load_creds

case "$CMD" in
  list)            cmd_list "$@";;
  search)          cmd_search "$@";;
  get|cat)         cmd_get "$@";;
  new|create)      cmd_new "$@";;
  edit|update)     cmd_edit "$@";;
  append)          cmd_append "$@";;
  mv|move)         cmd_mv "$@";;
  mvfolder|rename-folder) cmd_mvfolder "$@";;
  rm|delete)       cmd_rm "$@";;
  restore)         cmd_restore "$@";;
  purge)           cmd_purge "$@";;
  trash)           cmd_trash "$@";;
  empty-trash)     cmd_empty_trash "$@";;
  folders)         cmd_folders "$@";;
  findfolder)      cmd_findfolder "$@";;
  browse|ls)       cmd_browse "$@";;
  tags)            cmd_tags "$@";;
  versions)        cmd_versions "$@";;
  *) die "unknown command '$CMD' (try: vault.sh help)";;
esac

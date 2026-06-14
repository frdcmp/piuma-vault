#!/usr/bin/env bash
#
# build-and-upload.sh — Build a pv Expo artifact inside Docker and upload it
# to storage via a presigned PUT URL, with a live terminal UI.
#
# A target is REQUIRED (no default):
#   -p dev    development profile  -> .apk (dev client)  -> storage  expo/pv/dev/
#   -p apk    preview profile      -> .apk (standalone)  -> storage  expo/pv/apk/
#   -p prod   production profile    -> .aab (Play Store)  -> storage  expo/pv/prod/
#
# For -p apk, the patch version in app.json/package.json is auto-bumped before the
# build (so the new APK outranks the installed one), and an update manifest is
# written to expo/pv/apk/latest.json ({version,buildTime,apkKey,apkFilename,
# notes}). The mobile app reads it on open and offers a one-tap download.
#
# Examples:
#   ./build-and-upload.sh -p apk                 # bump + build + upload APK + manifest
#   ./build-and-upload.sh -p apk --notes "..."   # set the in-app update notes (apk)
#   ./build-and-upload.sh -p apk --no-bump       # don't auto-increment the version
#   ./build-and-upload.sh -p prod                # build + upload Play AAB
#   ./build-and-upload.sh -p dev --skip-build    # reuse existing dev artifact, upload
#   ./build-and-upload.sh -p apk --local         # upload via localhost:3000 backend
#   ./build-and-upload.sh -p apk --no-upload     # build only
#
# Uploads to https://vault.example.com by default (use --local for http://localhost:3000).
#
set -euo pipefail

# ----------------------------------------------------------------------------
# Config
# ----------------------------------------------------------------------------
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$HERE"

IMAGE="pv-eas:55"
BASE_DEV="http://localhost:3000/api/v1"
BASE_PROD="https://vault.example.com/api/v1"
BASE="$BASE_PROD"
ENV_FILE="../.env"
CT_APK="application/vnd.android.package-archive"
CT_AAB="application/octet-stream"

TARGET=""
DEST_FOLDER=""
DO_BUILD=1
DO_UPLOAD=1
DO_BUMP=1     # auto-increment the patch version (app.json + package.json) for -p apk
NOTES=""      # in-app update notes, embedded in the apk manifest

usage() { awk 'NR>1 && /^set -euo pipefail/{exit} NR>1{sub(/^# ?/,"");print}' "$0"; }

while [ $# -gt 0 ]; do
	case "$1" in
		-p|--target)  TARGET="${2:-}"; shift ;;
		--skip-build) DO_BUILD=0 ;;
		--no-upload)  DO_UPLOAD=0 ;;
		--no-bump)    DO_BUMP=0 ;;
		--notes)      NOTES="${2:-}"; shift ;;
		--local)      BASE="$BASE_DEV" ;;
		--folder)     DEST_FOLDER="$2"; shift ;;
		-h|--help)    usage; exit 0 ;;
		*) echo "unknown flag: $1" >&2; usage; exit 2 ;;
	esac
	shift
done

# Resolve the target into profile / extension / output name / content-type.
case "$TARGET" in
	dev)  PROFILE="development"; EXT="apk"; CONTENT_TYPE="$CT_APK"; KIND="dev-client APK" ;;
	apk)  PROFILE="preview";     EXT="apk"; CONTENT_TYPE="$CT_APK"; KIND="standalone APK" ;;
	prod) PROFILE="production";  EXT="aab"; CONTENT_TYPE="$CT_AAB"; KIND="Play Store AAB" ;;
	"")  echo "error: a target is required — pass -p dev|apk|prod" >&2; echo; usage; exit 2 ;;
	*)   echo "error: invalid target '$TARGET' (use dev|apk|prod)" >&2; exit 2 ;;
esac
OUT="pv-${TARGET}.${EXT}"
[ -n "$DEST_FOLDER" ] || DEST_FOLDER="expo/pv/$TARGET"

# ----------------------------------------------------------------------------
# UI helpers
# ----------------------------------------------------------------------------
if [ -t 1 ]; then
	B=$'\e[1m'; DIM=$'\e[2m'; R=$'\e[0m'
	RED=$'\e[31m'; GRN=$'\e[32m'; YLW=$'\e[33m'; BLU=$'\e[34m'; CYN=$'\e[36m'; MAG=$'\e[35m'
	HIDE=$'\e[?25l'; SHOW=$'\e[?25h'; CLR=$'\e[K'
else
	B=""; DIM=""; R=""; RED=""; GRN=""; YLW=""; BLU=""; CYN=""; MAG=""; HIDE=""; SHOW=""; CLR=""
fi

STEPS=("Preflight checks" "Docker image" "Build artifact" "Fix ownership" "Verify artifact" "Upload to storage")
TOTAL=${#STEPS[@]}
CUR=0
LOGDIR="$(mktemp -d)"

# Deterministic name for every `docker run` below so the cleanup trap can stop
# the container. `docker run` without `-d` only attaches the CLI client; on
# Ctrl-C the client dies but the (--rm) container keeps building on the daemon.
CONTAINER="pv-build-$$"

cleanup() {
	printf "%s" "$SHOW"
	# Stop the build container if it's still running (Ctrl-C / failure / normal
	# exit). `docker stop` triggers --rm so it's also removed.
	docker stop "$CONTAINER" >/dev/null 2>&1 || true
	rm -rf "$LOGDIR"
}
trap cleanup EXIT
# Convert SIGINT/SIGTERM into a normal exit so the EXIT trap above runs and the
# container is stopped instead of being orphaned on the daemon.
trap 'exit 130' INT TERM

banner() {
	printf "%s" "$HIDE"
	echo
	echo "${MAG}${B}  ╭───────────────────────────────────────────────╮${R}"
	echo "${MAG}${B}  │${R}  ${B}pv · Expo build & upload${R}                  ${MAG}${B}│${R}"
	echo "${MAG}${B}  ╰───────────────────────────────────────────────╯${R}"
	echo "${DIM}  target=${TARGET} (${KIND})  profile=${PROFILE}  out=${OUT}${R}"
	echo "${DIM}  dest=${DEST_FOLDER}/  api=${BASE}${R}"
	echo
}

progress_bar() {
	local done=$1 width=30 filled i bar=""
	filled=$(( done * width / TOTAL ))
	for ((i=0;i<width;i++)); do [ "$i" -lt "$filled" ] && bar+="█" || bar+="░"; done
	printf "  ${BLU}%s${R} ${B}%d/%d${R}\n\n" "$bar" "$done" "$TOTAL"
}

SPIN_FRAMES='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
run_step() {
	local label="$1"; shift
	CUR=$((CUR+1))
	local log="$LOGDIR/step$CUR.log"
	local n="[$CUR/$TOTAL]"
	( "$@" ) >"$log" 2>&1 &
	local pid=$!
	local i=0 start=$SECONDS
	while kill -0 "$pid" 2>/dev/null; do
		local f=${SPIN_FRAMES:i++%${#SPIN_FRAMES}:1}
		local el=$((SECONDS-start)) hint
		hint=$(tail -n 1 "$log" 2>/dev/null | tr -d '\r' | tr -cd '[:print:]' | cut -c1-46)
		printf "\r  ${CYN}%s${R} ${DIM}%s${R} ${B}%-22s${R} ${DIM}%3ds${R}  ${DIM}%s${R}%s" \
			"$f" "$n" "$label" "$el" "$hint" "$CLR"
		sleep 0.1
	done
	wait "$pid"; local rc=$?
	local el=$((SECONDS-start))
	if [ "$rc" -eq 0 ]; then
		printf "\r  ${GRN}✓${R} ${DIM}%s${R} ${B}%-22s${R} ${GRN}done${R} ${DIM}(%ds)${R}%s\n" "$n" "$label" "$el" "$CLR"
	else
		printf "\r  ${RED}✗${R} ${DIM}%s${R} ${B}%-22s${R} ${RED}FAILED${R} ${DIM}(rc=%d)${R}%s\n" "$n" "$label" "$rc" "$CLR"
		echo; echo "  ${RED}${B}--- last lines of output ---${R}"
		tail -n 20 "$log" | sed 's/^/  /'
		exit "$rc"
	fi
	return 0
}

# ----------------------------------------------------------------------------
# Step bodies
# ----------------------------------------------------------------------------
read_env() {
	grep -E "^[[:space:]]*$1=" "$ENV_FILE" 2>/dev/null | head -1 \
		| cut -d= -f2- | tr -d '"' | tr -d '[:space:]'
}

preflight() {
	command -v docker >/dev/null || { echo "docker not found"; return 1; }
	docker info >/dev/null 2>&1 || { echo "docker daemon not reachable"; return 1; }
	[ -f "$ENV_FILE" ] || { echo "missing $ENV_FILE"; return 1; }
	[ -n "${EXPO_TOKEN:-}" ] || { echo "EXPO_TOKEN not set (env or $ENV_FILE)"; return 1; }
	if [ "$DO_UPLOAD" -eq 1 ] && [ -z "${API_KEY:-}" ]; then
		echo "VAULT_API_KEY not set (env or $ENV_FILE; needs storage.access). Add it or use --no-upload."
		return 1
	fi
	echo "docker ok; token ok; target=$TARGET upload=$DO_UPLOAD"
}

ensure_image() {
	if docker image inspect "$IMAGE" >/dev/null 2>&1; then
		echo "image $IMAGE already present — skipping build"
	else
		echo "building image $IMAGE (first run downloads ~5.3GB)…"
		docker build -f Dockerfile.build -t "$IMAGE" .
	fi
}

build_artifact() {
	if [ "$DO_BUILD" -eq 0 ]; then
		[ -f "$OUT" ] || { echo "--skip-build but $OUT is missing"; return 1; }
		echo "skipping build (reusing $OUT)"
		return 0
	fi
	docker run --rm --name "$CONTAINER" \
		-v "$PWD":/app \
		-v /app/node_modules \
		-v pv-gradle:/root/.gradle \
		-e EXPO_TOKEN="$EXPO_TOKEN" \
		-e EAS_NO_VCS=1 \
		"$IMAGE" \
		bash -lc "set -e; bun install --frozen-lockfile && \
			eas build --platform android --profile $PROFILE --local \
				--non-interactive --output /app/$OUT"
}

fix_owner() {
	docker run --rm --name "$CONTAINER" -v "$PWD":/app "$IMAGE" chown "$(id -u):$(id -g)" "/app/$OUT"
	ls -l "$OUT" >/dev/null
}

verify_artifact() {
	if [ "$EXT" = "apk" ]; then
		docker run --rm --name "$CONTAINER" -v "$PWD":/app "$IMAGE" \
			bash -lc '$ANDROID_HOME/build-tools/36.0.0/aapt dump badging /app/'"$OUT"' \
				| grep -E "^package:|application-label:|targetSdkVersion:"'
	else
		# AAB is a zip; aapt can't read it. Sanity-check the bundle structure.
		docker run --rm --name "$CONTAINER" -v "$PWD":/app "$IMAGE" \
			bash -lc 'unzip -l /app/'"$OUT"' | grep -E "BundleConfig.pb|base/manifest|base/dex" | head'
		echo "aab ok ($(du -h "$OUT" | cut -f1))"
	fi
}

# Presign a PUT for $1=key from local $2=file with $3=content-type, then upload.
# Forces HTTP/1.1 (large APK uploads were hitting curl exit 92 — an HTTP/2 framing
# error — on the Bunny edge) and retries transient failures.
presign_put() {
	local key="$1" file="$2" ct="$3" url putcode
	url=$(curl -sf -X POST "$BASE/storage/presign-upload" \
		-H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
		-d "{\"key\":\"$key\",\"content_type\":\"$ct\",\"expires_in_secs\":900}" \
		| python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
	[ -n "$url" ] || { echo "presign returned no url for $key"; return 1; }
	putcode=$(curl -s --http1.1 --retry 3 --retry-all-errors -o /dev/null \
		-w '%{http_code}' -X PUT "$url" \
		-H "Content-Type: $ct" --data-binary @"$file")
	[ "$putcode" = "200" ] || { echo "PUT failed for $key: HTTP $putcode"; return 1; }
}

upload_artifact() {
	local ts key filename manifest_key manifest_file notes_json
	ts=$(date '+%Y-%m-%d_%H%M')
	filename="pv-$ts.$EXT"
	key="$DEST_FOLDER/$filename"
	echo "uploading $OUT → $key"
	presign_put "$key" "$OUT" "$CONTENT_TYPE" || return 1
	echo "$key" > "$LOGDIR/uploaded_key"
	echo "uploaded $key"

	# For standalone APKs, also publish an update manifest next to the artifact.
	# The mobile app reads it (GET /storage/app-update-manifest) on open, compares
	# `version` to its own build, and offers a one-tap download of `apkKey`.
	if [ "$TARGET" = "apk" ]; then
		manifest_key="$DEST_FOLDER/latest.json"
		manifest_file="$LOGDIR/latest.json"
		# json.dumps yields a quoted, escaped JSON string (handles quotes/newlines).
		notes_json=$(printf '%s' "$NOTES" | python3 -c 'import sys,json;print(json.dumps(sys.stdin.read()))')
		cat > "$manifest_file" <<-JSON
		{
		  "version": "${APP_VERSION}",
		  "buildTime": "${ts}",
		  "apkKey": "${key}",
		  "apkFilename": "${filename}",
		  "notes": ${notes_json}
		}
		JSON
		presign_put "$manifest_key" "$manifest_file" "application/json" || return 1
		echo "$manifest_key" > "$LOGDIR/manifest_key"
		echo "manifest $manifest_key (version $APP_VERSION)"
	fi
}

# Read the app version from app.json (the value EAS embeds as the APK's native
# versionName, and what the update manifest advertises).
read_app_version() {
	grep -m1 '"version"' app.json | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/'
}

# Auto-bump the patch version in app.json (+ package.json) so every apk build
# ships a higher version than the installed one — otherwise the in-app update
# check never fires. Only the version string is rewritten. Skipped with --no-bump.
bump_version() {
	local cur new
	cur="$(read_app_version)"
	new="$(printf '%s' "$cur" | awk -F. -v OFS=. '{$NF=$NF+1; print}')"
	sed -i "s/\"version\": \"${cur}\"/\"version\": \"${new}\"/" app.json
	sed -i "s/\"version\": \"${cur}\"/\"version\": \"${new}\"/" package.json 2>/dev/null || true
	echo "version bumped: ${cur} → ${new}"
}

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------
EXPO_TOKEN="${EXPO_TOKEN:-$(read_env EXPO_TOKEN)}"
API_KEY="${VAULT_API_KEY:-$(read_env VAULT_API_KEY)}"

# Bump before building so the artifact's versionName matches the manifest. Only
# for apk builds (the distributed target that publishes a manifest).
if [ "$TARGET" = "apk" ] && [ "$DO_BUMP" -eq 1 ] && [ "$DO_BUILD" -eq 1 ]; then
	bump_version
fi
APP_VERSION="$(read_app_version)"

banner
progress_bar 0

run_step "Preflight checks"  preflight ;        progress_bar 1
run_step "Docker image"      ensure_image ;     progress_bar 2
run_step "Build artifact"    build_artifact ;   progress_bar 3
run_step "Fix ownership"     fix_owner ;        progress_bar 4
run_step "Verify artifact"   verify_artifact ;  progress_bar 5

if [ "$DO_UPLOAD" -eq 1 ]; then
	run_step "Upload to storage" upload_artifact
else
	CUR=$((CUR+1))
	printf "  ${YLW}–${R} ${DIM}[%d/%d]${R} ${B}%-22s${R} ${YLW}skipped${R}\n" "$CUR" "$TOTAL" "Upload to storage"
fi
progress_bar "$TOTAL"

# Summary
size=$(du -h "$OUT" 2>/dev/null | cut -f1)

# Clean up the local temp artifact after a successful upload (kept on --no-upload).
cleaned=""
if [ "$DO_UPLOAD" -eq 1 ] && [ -f "$LOGDIR/uploaded_key" ]; then
	rm -f "$OUT" && cleaned=" — deleted locally"
fi

echo "${GRN}${B}  ╭──────────────── done ────────────────╮${R}"
printf "${GRN}${B}  │${R} %-38s ${GRN}${B}│${R}\n" "$KIND"
printf "${GRN}${B}  │${R} out   %-32s ${GRN}${B}│${R}\n" "$OUT ($size)$cleaned"
if [ "$DO_UPLOAD" -eq 1 ] && [ -f "$LOGDIR/uploaded_key" ]; then
	printf "${GRN}${B}  │${R} key   %-32s ${GRN}${B}│${R}\n" "$(cat "$LOGDIR/uploaded_key")"
fi
echo "${GRN}${B}  ╰──────────────────────────────────────╯${R}"
echo

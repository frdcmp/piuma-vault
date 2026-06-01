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
# Examples:
#   ./build-and-upload.sh -p apk                 # build + upload preview APK
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

usage() { awk 'NR>1 && /^set -euo pipefail/{exit} NR>1{sub(/^# ?/,"");print}' "$0"; }

while [ $# -gt 0 ]; do
	case "$1" in
		-p|--target)  TARGET="${2:-}"; shift ;;
		--skip-build) DO_BUILD=0 ;;
		--no-upload)  DO_UPLOAD=0 ;;
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
trap 'printf "%s" "$SHOW"; rm -rf "$LOGDIR"' EXIT

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
		echo "FRDCMP_API_KEY not set (env or $ENV_FILE; needs storage.access). Add it or use --no-upload."
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
	docker run --rm \
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
	docker run --rm -v "$PWD":/app "$IMAGE" chown "$(id -u):$(id -g)" "/app/$OUT"
	ls -l "$OUT" >/dev/null
}

verify_artifact() {
	if [ "$EXT" = "apk" ]; then
		docker run --rm -v "$PWD":/app "$IMAGE" \
			bash -lc '$ANDROID_HOME/build-tools/36.0.0/aapt dump badging /app/'"$OUT"' \
				| grep -E "^package:|application-label:|targetSdkVersion:"'
	else
		# AAB is a zip; aapt can't read it. Sanity-check the bundle structure.
		docker run --rm -v "$PWD":/app "$IMAGE" \
			bash -lc 'unzip -l /app/'"$OUT"' | grep -E "BundleConfig.pb|base/manifest|base/dex" | head'
		echo "aab ok ($(du -h "$OUT" | cut -f1))"
	fi
}

upload_artifact() {
	local ts key url putcode
	ts=$(date '+%Y-%m-%d_%H%M')
	key="$DEST_FOLDER/pv-$ts.$EXT"
	echo "requesting presigned PUT url for $key"
	url=$(curl -sf -X POST "$BASE/storage/presign-upload" \
		-H "x-api-key: $API_KEY" -H "Content-Type: application/json" \
		-d "{\"key\":\"$key\",\"content_type\":\"$CONTENT_TYPE\",\"expires_in_secs\":900}" \
		| python3 -c 'import sys,json;print(json.load(sys.stdin)["url"])')
	[ -n "$url" ] || { echo "presign returned no url"; return 1; }
	echo "uploading bytes to bucket…"
	putcode=$(curl -s -o /dev/null -w '%{http_code}' -X PUT "$url" \
		-H "Content-Type: $CONTENT_TYPE" --data-binary @"$OUT")
	[ "$putcode" = "200" ] || { echo "PUT failed: HTTP $putcode"; return 1; }
	echo "$key" > "$LOGDIR/uploaded_key"
	echo "uploaded $key"
}

# ----------------------------------------------------------------------------
# Run
# ----------------------------------------------------------------------------
EXPO_TOKEN="${EXPO_TOKEN:-$(read_env EXPO_TOKEN)}"
API_KEY="${FRDCMP_API_KEY:-$(read_env FRDCMP_API_KEY)}"

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

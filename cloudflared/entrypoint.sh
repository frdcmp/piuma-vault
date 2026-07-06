#!/bin/sh
# Health-gated Cloudflare Tunnel supervisor (single process tree).
#
# Polls the full public chain through nginx (nginx -> rust). While healthy it
# keeps cloudflared connected; after FAIL_THRESHOLD consecutive failures it
# SIGTERMs cloudflared (which drains + deregisters from the edge so Cloudflare
# fails over to other connectors); after OK_THRESHOLD consecutive recoveries it
# reconnects. Hysteresis is intentionally ASYMMETRIC: drop fast (low
# FAIL_THRESHOLD) so the edge never routes to a dead backend, but re-add slow
# (higher OK_THRESHOLD) so a flapping/recovering backend can't yo-yo the edge.
set -u

: "${TUNNEL_TOKEN:?TUNNEL_TOKEN is required}"
# Under host networking the probe reaches nginx via the host's published port;
# docker-compose sets CLOUDFLARED_HEALTH_URL explicitly, this is just a fallback.
CHECK_URL="${CLOUDFLARED_HEALTH_URL:-http://localhost:8001/api/v1/health}"
FAIL_THRESHOLD="${FAIL_THRESHOLD:-1}"
OK_THRESHOLD="${OK_THRESHOLD:-3}"
POLL_INTERVAL="${POLL_INTERVAL:-2}"

CF_PID=""

start_cf() {
  cloudflared --no-autoupdate tunnel run &
  CF_PID=$!
  echo "[watchdog] backend healthy -> cloudflared connected (pid $CF_PID)"
}

stop_cf() {
  [ -n "$CF_PID" ] || return 0
  if kill -0 "$CF_PID" 2>/dev/null; then
    echo "[watchdog] backend unhealthy -> draining cloudflared (pid $CF_PID)"
    kill -TERM "$CF_PID" 2>/dev/null
    wait "$CF_PID" 2>/dev/null
  fi
  CF_PID=""
}

# Clean shutdown when the container is stopped.
trap 'stop_cf; exit 0' TERM INT

fails=0
oks=0
up=0
echo "[watchdog] polling $CHECK_URL every ${POLL_INTERVAL}s (fail=$FAIL_THRESHOLD ok=$OK_THRESHOLD)"

while true; do
  if wget -qO- -T2 "$CHECK_URL" >/dev/null 2>&1; then
    oks=$((oks + 1)); fails=0
    if [ "$up" = 0 ] && [ "$oks" -ge "$OK_THRESHOLD" ]; then
      start_cf; up=1
    fi
  else
    fails=$((fails + 1)); oks=0
    if [ "$up" = 1 ] && [ "$fails" -ge "$FAIL_THRESHOLD" ]; then
      stop_cf; up=0
    fi
  fi

  # If cloudflared died on its own (e.g. token/edge error), reset so the next
  # healthy check brings it back up rather than leaving a dead connector.
  if [ "$up" = 1 ] && ! kill -0 "$CF_PID" 2>/dev/null; then
    echo "[watchdog] cloudflared exited unexpectedly; will reconnect when healthy"
    CF_PID=""; up=0; oks=0
  fi

  sleep "$POLL_INTERVAL"
done

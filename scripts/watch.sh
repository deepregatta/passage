#!/usr/bin/env bash
# Watch mode (local stand-in for the future scheduled shared-prep job):
# every INTERVAL seconds, refresh prepared data and re-run the audit for a passage.
# Snapshots are write-once and keyed by input digests, so a re-run with unchanged
# forecasts is refused (harmless) — a new model run produces a NEW snapshot, and
# the viewer's Changes page shows the previous→latest ledger.
#
# Usage: scripts/watch.sh <departure ISO UTC> [route.json] [interval seconds]
set -uo pipefail
cd "$(dirname "$0")/.."

DEPARTURE="${1:?usage: watch.sh <departure ISO UTC> [route.json] [interval]}"
ROUTE="${2:-config/routes/cherbourg-plymouth.json}"
INTERVAL="${3:-1800}"

echo "watching $ROUTE for departure $DEPARTURE (every ${INTERVAL}s; ctrl-c to stop)"
while true; do
  echo "--- $(date -u +%H:%M:%SZ) refreshing prepared data ---"
  (cd analysis && uv run deepweather-analysis fetch-currents 2>&1 | tail -1) || true
  out=$(npm -w engine run cli --silent -- run --route "$ROUTE" --departure "$DEPARTURE" 2>&1)
  if echo "$out" | grep -q "already exists"; then
    echo "no new model run yet — snapshot unchanged"
  else
    echo "$out" | head -3
  fi
  sleep "$INTERVAL"
done

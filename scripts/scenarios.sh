#!/usr/bin/env bash
# Verdict-state harness: regenerate the five synthetic scenario bundles, run each
# through the engine, and write snapshots so all five §7 states are visible in the
# viewer. Scenario snapshots are removed first (snapshots are write-once).
set -euo pipefail
cd "$(dirname "$0")/.."

DEPARTURE="${1:-2026-07-20T06:00:00Z}"

(cd analysis && uv run deepweather-analysis scenario all --departure "$DEPARTURE")

# clear previous scenario snapshots (identified by the scenario departure date)
compact="${DEPARTURE//[-:]/}"
rm -rf data/processed/snapshots/"${compact%%Z*}"* 2>/dev/null || true

for s in calm approaching storm diverging warning; do
  echo "--- $s ---"
  npm -w engine run cli --silent -- run --departure "$DEPARTURE" --fixture-dir "data/scenarios/$s"
done

echo
echo "Five scenario snapshots written — open the viewer to see all five verdict states."

#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
bash scripts/build.sh
mkdir -p test-results
node tests/engineering-records-e2e.mjs | tee test-results/engineering-records-e2e.log
export REIFY_FIXTURE_PORT="${REIFY_FIXTURE_PORT:-0}"
: > test-results/fixture.log
node tests/fixture.mjs > test-results/fixture.log 2>&1 &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
for attempt in {1..50}; do
  fixture_url=$(sed -n 's/^READY //p' test-results/fixture.log)
  if [[ -n "$fixture_url" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat test-results/fixture.log; exit 1; fi
  sleep 0.1
done
[[ -n "${fixture_url:-}" ]] || { cat test-results/fixture.log; exit 1; }
export REIFY_CLOUD_URL="$fixture_url"
.build/manual/ReifyE2E | tee test-results/api-e2e.log
REIFY_DESKTOP_SETTINGS_PATH="$PWD/test-results/desktop-settings-$$.json" REIFY_APPROVAL_ROOT="$PWD/test-results/approval-store" REIFY_SESSION_SCOPE=e2e-flow REIFY_PREFERENCES_SCOPE=app.reify.e2e.flow .build/manual/ReifyFlowE2E | tee test-results/flow-e2e.log
curl --silent --fail "$REIFY_CLOUD_URL/__test/stats" > test-results/api-stats.json
node tests/check-protocol-e2e.mjs test-results/api-stats.json

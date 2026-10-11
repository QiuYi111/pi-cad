#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "${REIFY_SKIP_BUILD:-0}" != 1 ]]; then bash scripts/build.sh; fi
mkdir -p test-results/render-e2e
export REIFY_FIXTURE_PORT=0
node tests/fixture.mjs > test-results/render-e2e/fixture.log 2>&1 &
fixture_pid=$!
trap 'kill "$fixture_pid" 2>/dev/null || true' EXIT
for attempt in {1..50}; do
  fixture_url=$(sed -n 's/^READY //p' test-results/render-e2e/fixture.log)
  if [[ -n "$fixture_url" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat test-results/render-e2e/fixture.log; exit 1; fi
  sleep 0.1
done
[[ -n "${fixture_url:-}" ]] || { cat test-results/render-e2e/fixture.log; exit 1; }
export REIFY_CLOUD_URL="$fixture_url"
export REIFY_SESSION_SCOPE="render-e2e-$$"
export REIFY_PREFERENCES_SCOPE="app.reify.render-e2e-$$"
export REIFY_TRANSFER_HOME="$PWD/test-results/render-e2e/fusion-home-$$"
export REIFY_APPROVAL_ROOT="$PWD/test-results/render-e2e/approvals-$$"
export REIFY_DESKTOP_SETTINGS_PATH="$PWD/test-results/render-e2e/desktop-settings-$$.json"
.build/manual/ReifyRenderE2E | tee test-results/render-e2e/run.log
curl --silent --fail "$REIFY_CLOUD_URL/__test/stats" > test-results/render-e2e/api-stats.json
node tests/check-render-e2e.mjs test-results/render-e2e

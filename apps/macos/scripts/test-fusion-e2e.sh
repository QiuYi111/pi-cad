#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p test-results .build/manual
node scripts/build-desktop-transfer.mjs .build/manual/DesktopTransfer.js
sdk="${REIFY_MACOS_SDK:-$(xcrun --show-sdk-path)}"
if [[ -z "${REIFY_MACOS_SDK:-}" && -d "$sdk/../MacOSX26.sdk" ]]; then sdk="$sdk/../MacOSX26.sdk"; fi
sources=()
for source in Sources/Reify/*.swift; do
  [[ "$source" == Sources/Reify/ReifyApp.swift ]] || sources+=("$source")
done
if [[ "${REIFY_FUSION_SKIP_BUILD:-0}" == "1" ]]; then
  [[ -x .build/manual/ReifyFusionE2E ]] || { echo 'Build the Fusion E2E binary first'; exit 1; }
  for source in "${sources[@]}" Sources/ReifyFlowE2E/FusionE2E.swift Sources/ReifyFusionE2E/main.swift; do
    [[ "$source" -nt .build/manual/ReifyFusionE2E ]] && { echo 'Fusion E2E binary is stale'; exit 1; }
  done
else
swiftc -sdk "$sdk" -target "$(uname -m)-apple-macosx14.0" -parse-as-library -swift-version 5 -I .build/manual -L .build/manual -lReifyCloud \
 "${sources[@]}" Sources/ReifyFlowE2E/FusionE2E.swift Sources/ReifyFusionE2E/main.swift -o .build/manual/ReifyFusionE2E -Xlinker -rpath -Xlinker @executable_path
fi
export REIFY_FIXTURE_PORT=0
node tests/fixture.mjs > test-results/fusion-fixture.log 2>&1 &
fixture_pid=$!
cleanup() {
  if [[ -n "${fixture_url:-}" ]]; then curl --silent --fail "$fixture_url/__test/stats" > test-results/fusion-api-stats.json || true; fi
  kill "$fixture_pid" 2>/dev/null || true
  rm -rf "$PWD/test-results/fusion-home-$$" "$PWD/test-results/fusion-approval-store-$$"
  rm -f "$PWD/test-results/fusion-settings-$$.json"
}
trap cleanup EXIT
for attempt in {1..50}; do
  fixture_url=$(sed -n 's/^READY //p' test-results/fusion-fixture.log)
  if [[ -n "$fixture_url" ]]; then break; fi
  if ! kill -0 "$fixture_pid" 2>/dev/null; then cat test-results/fusion-fixture.log; exit 1; fi
  sleep 0.1
done
[[ -n "${fixture_url:-}" ]] || { cat test-results/fusion-fixture.log; exit 1; }
REIFY_CLOUD_URL="$fixture_url" REIFY_SESSION_SCOPE=e2e-fusion REIFY_PREFERENCES_SCOPE=app.reify.e2e.fusion REIFY_TRANSFER_HOME="$PWD/test-results/fusion-home-$$" REIFY_APPROVAL_ROOT="$PWD/test-results/fusion-approval-store-$$" REIFY_DESKTOP_SETTINGS_PATH="$PWD/test-results/fusion-settings-$$.json" .build/manual/ReifyFusionE2E

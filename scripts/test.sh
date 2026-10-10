#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Every area, every layer (see tests/areas.yaml). CI runs the same runners with
# --areas and --systems (.github/workflows/ci.yml).

# TypeScript harness tests.
if [ ! -d node_modules/jiti ]; then
  npm install --ignore-scripts --cache .npm-cache
fi
node tests/run-ts-tests.mjs

# Python backend tests use the same uv-managed project as the Node harness.
node tests/run-py-tests.mjs --extra simulation

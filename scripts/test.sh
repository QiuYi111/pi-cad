#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# TypeScript harness tests.
if [ ! -d node_modules/jiti ]; then
  npm install --ignore-scripts --cache .npm-cache
fi
node tests/run-ts-tests.mjs

# Python backend integration tests use the same uv-managed project as the
# Node harness.
PYTHONPATH="$PWD/skills/cad/src${PYTHONPATH:+:$PYTHONPATH}" \
  PYTHONDONTWRITEBYTECODE=1 \
  uv run --offline --frozen --project python --extra simulation python -m unittest discover -s tests -p 'test_*.py'

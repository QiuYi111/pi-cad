#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# TypeScript harness tests.
if [ ! -d node_modules/jiti ]; then
  npm install --ignore-scripts --cache .npm-cache
fi
node tests/run-ts-tests.mjs

# Python backend integration tests.
PYTHON_BIN="${PI_CAD_PYTHON:-}"
if [ -z "$PYTHON_BIN" ] && [ -x .venv/bin/python ]; then
  PYTHON_BIN=.venv/bin/python
fi
if [ -z "$PYTHON_BIN" ] && [ -d .python/site-packages ]; then
  PYTHON_BIN=python3
fi
if [ -z "$PYTHON_BIN" ]; then
  echo "Python backend is not set up. Run scripts/bootstrap-python.sh first." >&2
  exit 1
fi

# The venv is self-contained: never let the .python/site-packages fallback
# layout shadow it (those extensions may be built for another Python).
if [ -x .venv/bin/python ]; then
  export PYTHONPATH="$(pwd)/python${PYTHONPATH:+:$PYTHONPATH}"
elif [ -d .python/site-packages ]; then
  export PYTHONPATH="$(pwd)/.python/site-packages:$(pwd)/python${PYTHONPATH:+:$PYTHONPATH}"
fi
"${PYTHON_BIN}" -m unittest discover -s tests -p 'test_*.py'

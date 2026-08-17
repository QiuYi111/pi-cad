#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Preferred path: a normal virtualenv.
if python3 -m venv .venv 2>/dev/null; then
  echo "[pi-cad] using .venv"
  .venv/bin/python -m pip install --upgrade pip >/dev/null
  .venv/bin/python -m pip install -r python/requirements.txt
  exit 0
fi

# Fallback path for read-only home directories or systems without ensurepip:
# keep every Python dependency under .python/ inside the repository.
echo "[pi-cad] venv unavailable; installing into .python/site-packages"
mkdir -p .python/pip-target .python/site-packages
if ! PYTHONPATH=.python/pip-target python3 -c 'import pip' 2>/dev/null; then
  curl -fsSL https://bootstrap.pypa.io/get-pip.py -o .python/get-pip.py
  python3 .python/get-pip.py --target .python/pip-target --no-cache-dir
fi
PYTHONPATH=.python/pip-target python3 -m pip install \
  --target .python/site-packages \
  --no-cache-dir \
  -r python/requirements.txt
echo "[pi-cad] Python dependencies ready under .python/site-packages"

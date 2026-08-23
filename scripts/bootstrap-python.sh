#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The Node entrypoint delegates all Python environment work to uv. On a
# Windows host it launches uv inside WSL and never creates a Windows venv for
# a WSL-backed checkout.
node scripts/postinstall.mjs

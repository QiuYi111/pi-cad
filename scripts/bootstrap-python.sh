#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# Pi-CAD 0.6 uses the cross-platform Node postinstall as the single Python
# runtime bootstrap. It creates .venv when possible and falls back to a
# repository-local .python/site-packages target install.
node scripts/postinstall.mjs

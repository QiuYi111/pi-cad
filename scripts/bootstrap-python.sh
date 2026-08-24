#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

# The Node entrypoint and uv both run in the same Linux environment. WSL is
# supported only when this script is invoked from inside the distribution.
node scripts/postinstall.mjs

#!/usr/bin/env bash
set -euo pipefail

repository="${PI_CAD_REPO:-/home/jingyi/pi-cad-plan-c-tests}"
export PI_CAD_REPO="$repository"
export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"

exec node "$repository/scripts/prime-plan-c.mjs" "$@"

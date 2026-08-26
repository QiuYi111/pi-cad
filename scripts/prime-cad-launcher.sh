#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repository="${PI_CAD_REPO:-$(cd "$script_dir/.." && pwd)}"
export PI_CAD_REPO="$repository"
export PYTHONDONTWRITEBYTECODE="${PYTHONDONTWRITEBYTECODE:-1}"

exec node "$repository/scripts/prime-cad-sidecar.mjs" "$@"

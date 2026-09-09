#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="${PI_CAD_ROOT:-$(cd "$script_dir/.." && pwd)}"
port="${BLENDER_MCP_PORT:-9876}"
manifest="$root/scripts/blender-manifest.json"
version="$(uv run python -c 'import json,sys; print(json.load(open(sys.argv[1]))["version"])' "$manifest")"
arch="$(uname -m)"
case "$arch" in
  x86_64|amd64) platform=linux-x64 ;;
  aarch64|arm64) platform=linux-arm64 ;;
  *) echo "Unsupported Blender CPU architecture: $arch" >&2; exit 2 ;;
esac
binary="$root/.runtime/blender/$version/$platform/blender"
addon="$root/third_party/blender-mcp/addon"
if [[ ! -x "$binary" ]]; then
  echo "Managed Blender $version is missing. Run: cd '$root' && node scripts/install-blender.mjs" >&2
  exit 2
fi
export OMP_NUM_THREADS="${OMP_NUM_THREADS:-1}"
export LD_LIBRARY_PATH="$(dirname "$binary")/lib${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"
exec "$binary" --background --factory-startup --online-mode \
  --python-expr "import sys;sys.path.insert(0,'$addon');import blender_mcp_addon;blender_mcp_addon.register()" \
  --command blender_mcp --host 127.0.0.1 --port "$port"

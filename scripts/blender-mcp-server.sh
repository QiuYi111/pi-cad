#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
mcp_root="${PI_CAD_BLENDER_MCP_ROOT:-$repo_root/third_party/blender-mcp}"
export PYTHONPATH="$mcp_root/deps:$mcp_root/mcp${PYTHONPATH:+:$PYTHONPATH}"
kernel_python="${PRIME_AGENT_KERNEL_PYTHON:-}"
if [[ -z "$kernel_python" && -n "${PRIME_AGENT_KERNEL_VENV:-}" ]]; then
  kernel_python="$PRIME_AGENT_KERNEL_VENV/bin/python"
fi
exec "${kernel_python:-python3}" -m blmcp --transport stdio

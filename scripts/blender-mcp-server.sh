#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
mcp_root="${PI_CAD_BLENDER_MCP_ROOT:-$repo_root/third_party/blender-mcp}"
export PYTHONPATH="$mcp_root/deps:$mcp_root/mcp${PYTHONPATH:+:$PYTHONPATH}"
exec "${PRIME_AGENT_KERNEL_PYTHON:-python3}" -m blmcp --transport stdio

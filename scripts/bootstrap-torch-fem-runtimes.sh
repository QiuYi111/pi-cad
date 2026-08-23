#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "torch-fem bootstrap must run inside Linux/WSL." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
uv_source="$(command -v uv || true)"
test -n "$uv_source"

sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap
if [ "$(realpath "$uv_source")" != "/usr/local/bin/uv" ]; then
  sudo install -m 0755 "$uv_source" /usr/local/bin/uv
fi

install_runtime() {
  runtime_name="$1"
  runtime_project="$2"
  target="/opt/pi-cad-runtime/$runtime_name"
  sudo rm -rf "$target"
  sudo install -d -m 0755 "$target/project"
  tar -C "$repo_root" --exclude='python/.venv' --exclude='python/**/__pycache__' -cf - python \
    | sudo tar -C "$target/project" -xf -
  sudo env UV_PYTHON_INSTALL_DIR="$target/python" \
    UV_PROJECT_ENVIRONMENT="$target/project/$runtime_project/.venv" \
    uv sync --frozen --project "$target/project/$runtime_project"
  sudo chmod -R a-w "$target"
}

install_runtime "torch-fem-0.9-cu126" "python/runtimes/torch-fem-cuda"
install_runtime "torch-fem-0.9-cpu" "python/runtimes/torch-fem-cpu"

cuda_project="/opt/pi-cad-runtime/torch-fem-0.9-cu126/project/python/runtimes/torch-fem-cuda"
uv run --offline --frozen --project "$cuda_project" python "$repo_root/scripts/probe-torch-fem-runtime.py" --require cuda
cpu_project="/opt/pi-cad-runtime/torch-fem-0.9-cpu/project/python/runtimes/torch-fem-cpu"
uv run --offline --frozen --project "$cpu_project" python "$repo_root/scripts/probe-torch-fem-runtime.py" --require cpu

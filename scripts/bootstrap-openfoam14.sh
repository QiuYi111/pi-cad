#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "OpenFOAM bootstrap must run inside Linux/WSL." >&2
  exit 2
fi

sudo install -d -m 0755 /etc/apt/keyrings
curl -fsSL https://dl.openfoam.org/gpg.key | sudo gpg --dearmor --yes -o /etc/apt/keyrings/openfoam.gpg
printf '%s\n' "deb [signed-by=/etc/apt/keyrings/openfoam.gpg] http://dl.openfoam.org/ubuntu $(. /etc/os-release && printf %s \"$VERSION_CODENAME\") main" \
  | sudo tee /etc/apt/sources.list.d/openfoam.list >/dev/null
sudo apt-get update
sudo apt-get install -y --no-install-recommends openfoam14=20260724 bubblewrap

# Freeze a small observer environment into the managed runtime. The compute
# sandbox mounts this read-only and runs it with uv --offline --frozen.
uv_source="$(command -v uv || true)"
if [ -z "$uv_source" ]; then
  uv_source="$(find /home -path '*/.local/bin/uv' -type f -print -quit)"
fi
test -n "$uv_source"
if [ "$(realpath "$uv_source")" != "/usr/local/bin/uv" ]; then
  sudo install -m 0755 "$uv_source" /usr/local/bin/uv
fi
sudo rm -rf /opt/pi-cad-runtime/python
sudo install -d -m 0755 /opt/pi-cad-runtime/python
sudo tee /opt/pi-cad-runtime/python/pyproject.toml >/dev/null <<'EOF'
[project]
name = "pi-cad-simulation-observer"
version = "1.0.0"
requires-python = ">=3.12,<3.13"
dependencies = ["numpy==2.4.3", "matplotlib==3.10.8", "pillow==12.1.1"]
EOF
sudo env UV_PYTHON=3.12 UV_MANAGED_PYTHON=1 \
  UV_PYTHON_INSTALL_DIR=/opt/pi-cad-runtime/python/.python \
  uv sync --project /opt/pi-cad-runtime/python
sudo chmod -R a-w /opt/pi-cad-runtime/python

version="$(dpkg-query -W -f='${Version}' openfoam14)"
case "$version" in
  *20260724*) ;;
  *) echo "Expected OpenFOAM 14 patch 20260724, installed $version" >&2; exit 3 ;;
esac

test -f /opt/openfoam14/etc/bashrc
test -x /opt/pi-cad-runtime/python/.venv/bin/python
bwrap --version
echo "OpenFOAM runtime ready: openfoam14@$version"

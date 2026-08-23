#!/usr/bin/env bash
set -euo pipefail

if [ "$(uname -s)" != Linux ]; then
  echo "SU2 bootstrap must run inside Linux/WSL." >&2
  exit 2
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
target="/opt/pi-cad-runtime/su2/8.5.0"
archive="$(mktemp --suffix=.zip)"
trap 'rm -f "$archive"' EXIT

sudo apt-get update
sudo apt-get install -y --no-install-recommends bubblewrap
uv_source="$(command -v uv)"
if [ "$(realpath "$uv_source")" != "/usr/local/bin/uv" ]; then
  sudo install -m 0755 "$uv_source" /usr/local/bin/uv
fi
curl -fL "https://github.com/su2code/SU2/releases/download/v8.5.0/SU2-v8.5.0-linux64-omp.zip" -o "$archive"
printf '%s  %s\n' "aadc800cd9df34deff99d4725f5897f620c9f2979f62ab235313311bf501f09b" "$archive" | sha256sum -c -

sudo rm -rf "$target"
sudo install -d -m 0755 "$target/bin" "$target/project"
uv run --frozen --project "$repo_root/python" python - "$archive" "$target/bin/SU2_CFD" <<'PY'
import io, pathlib, sys, zipfile
outer = zipfile.ZipFile(sys.argv[1])
inner = zipfile.ZipFile(io.BytesIO(outer.read(outer.namelist()[0])))
data = inner.read("bin/SU2_CFD")
path = pathlib.Path(sys.argv[2])
tmp = pathlib.Path("/tmp/pi-cad-su2-cfd")
tmp.write_bytes(data)
print(tmp)
PY
sudo install -m 0755 /tmp/pi-cad-su2-cfd "$target/bin/SU2_CFD"
rm -f /tmp/pi-cad-su2-cfd
tar -C "$repo_root" --exclude='python/.venv' --exclude='python/**/__pycache__' -cf - python \
  | sudo tar -C "$target/project" -xf -
sudo env UV_PYTHON_INSTALL_DIR="$target/python" \
  UV_PROJECT_ENVIRONMENT="$target/project/python/runtimes/su2/.venv" \
  uv sync --frozen --project "$target/project/python/runtimes/su2"
"$target/bin/SU2_CFD" --help 2>&1 | grep -F "SU2 v8.5.0"
sudo chmod -R a-w "$target"

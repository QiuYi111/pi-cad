#!/usr/bin/env bash
# Installs the reify-asi feature analyzer (Analysis Situs v2024.2 asiAlgo + OCCT 7.6)
# into a private prefix. Never uses sudo and never touches shell configuration files.
#
# Usage: bash scripts/bootstrap-asi.sh [--force]
#   --force  removes the install root's env, sources, build and runtime.json and rebuilds.
#
# Layout under the install root (default ${XDG_DATA_HOME:-$HOME/.local/share}/pi-cad/runtimes/asi):
#   env/            micromamba prefix: occt 7.6, eigen, rapidjson, cmake, make, compilers
#   src/            Analysis Situs v2024.2 src/ (from the pinned archive, patched)
#   build/          CMake build tree
#   bin/reify-asi   wrapper that sets LD_LIBRARY_PATH to env/lib and runs bin/reify-asi-bin
#   runtime.json    versions and timings
#
# Exit codes: 0 ok, 2 unsupported platform, 3 download or checksum failed,
#             4 environment creation failed, 5 smoke test failed,
#             6 source extraction, patch or build failed.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
FORCE=0
[ "${1:-}" = "--force" ] && FORCE=1

ASI_VERSION="2024.2"
ASI_ARCHIVE_URL="https://gitlab.com/ssv/AnalysisSitus/-/archive/v${ASI_VERSION}/AnalysisSitus-v${ASI_VERSION}.tar.gz"
ASI_ARCHIVE_SHA256="ea655706d40631e01867649f33520fff463c536cd322bda66c1f911315511c25"
# micromamba is the same pinned build the FreeCAD bootstrap uses.
MICROMAMBA_VERSION="2.9.0"
MICROMAMBA_BUILD="0"
MICROMAMBA_SHA256_LINUX_64="8761c382127e6363bd9e0a2451aa3ef90d071a79133f736e2f759a3bf13040dd"
CHANNEL_URL="${PI_CAD_CONDA_CHANNEL_URL:-https://conda.anaconda.org/conda-forge}"

os="$(uname -s)"
arch="$(uname -m)"
if [ "$os/$arch" != "Linux/x86_64" ]; then
  echo "[pi-cad] reify-asi supports Linux x86_64 (including WSL) only; found $os/$arch" >&2
  exit 2
fi

ASI_HOME="${PI_CAD_ASI_HOME:-${XDG_DATA_HOME:-$HOME/.local/share}/pi-cad/runtimes/asi}"
ENV_DIR="$ASI_HOME/env"
SRC_TOP="$ASI_HOME/analysis-situs-$ASI_VERSION"
SRC_DIR="$SRC_TOP/src"
BUILD_DIR="$ASI_HOME/build"
BIN_DIR="$ASI_HOME/bin"
DOWNLOAD_DIR="$ASI_HOME/downloads"
RUNTIME_JSON="$ASI_HOME/runtime.json"
MICROMAMBA="$BIN_DIR/micromamba"
LOCK="$ROOT/native/reify-asi/conda-linux-64.lock"
PATCH="$ROOT/native/reify-asi/patches/asiAlgo-utils-no-x11.patch"
PATCH_MARKER="reify-asi: rendering is not available"

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

json_escape() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }

smoke_test() {
  local bin="$BIN_DIR/reify-asi"
  local out
  out="$(mktemp "${TMPDIR:-/tmp}/pi-cad-asi-smoke.XXXXXX.json")"
  if ! "$bin" --version >/dev/null; then rm -f "$out"; return 1; fi
  if ! "$bin" analyze --in "$ROOT/native/reify-asi/testdata/plate_4holes.brep" --out "$out" --checks holes >/dev/null; then
    rm -f "$out"; return 1
  fi
  # The fixture is a 40 x 30 x 5 plate with four through holes of diameter 3.
  local holes through diameter
  holes="$(grep -o '"through": true' "$out" | wc -l | tr -d ' ')"
  diameter="$(grep -o '"diameter": 3,' "$out" | wc -l | tr -d ' ')"
  rm -f "$out"
  [ "$holes" = "4" ] && [ "$diameter" = "4" ]
}

write_runtime_json() {
  local lib_dir="$ENV_DIR/lib" occt eigen gxx build_s installed binsize
  local ver="$ENV_DIR/include/opencascade/Standard_Version.hxx"
  occt="$(sed -n 's/^#define OCC_VERSION_MAJOR *\([0-9]*\)/\1/p' "$ver" | head -1).$(sed -n 's/^#define OCC_VERSION_MINOR *\([0-9]*\)/\1/p' "$ver" | head -1).$(sed -n 's/^#define OCC_VERSION_MAINTENANCE *\([0-9]*\)/\1/p' "$ver" | head -1)"
  eigen="$(ls "$ENV_DIR/conda-meta" | sed -n 's/^eigen-\([^-]*\)-.*\.json$/\1/p' | head -1)"
  gxx="$("$ENV_DIR/bin/x86_64-conda-linux-gnu-g++" -dumpversion 2>/dev/null || echo unknown)"
  build_s="${ASI_BUILD_SECONDS:-0}"
  installed="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  binsize="$(stat -c %s "$BIN_DIR/reify-asi-bin")"
  cat > "$RUNTIME_JSON" <<EOF
{
  "schema": 1,
  "asi": "$(json_escape "$ASI_VERSION")",
  "asiSourceUrl": "$(json_escape "$ASI_ARCHIVE_URL")",
  "asiSourceSha256": "$ASI_ARCHIVE_SHA256",
  "occt": "$(json_escape "$occt")",
  "eigen": "$(json_escape "$eigen")",
  "compiler": "$(json_escape "$gxx")",
  "binary": "$(json_escape "$BIN_DIR/reify-asi")",
  "binaryBytes": $binsize,
  "libPath": "$(json_escape "$lib_dir")",
  "platform": "linux-64",
  "buildSeconds": $build_s,
  "installedAt": "$installed"
}
EOF
}

mkdir -p "$ASI_HOME" "$BIN_DIR" "$DOWNLOAD_DIR"

if [ "$FORCE" = 1 ]; then
  rm -rf "$ENV_DIR" "$SRC_TOP" "$BUILD_DIR" "$RUNTIME_JSON" "$BIN_DIR/reify-asi" "$BIN_DIR/reify-asi-bin"
fi

if [ -x "$BIN_DIR/reify-asi" ] && [ -f "$RUNTIME_JSON" ] && [ -x "$BIN_DIR/reify-asi-bin" ]; then
  echo "[pi-cad] reify-asi already installed at $ASI_HOME; re-running the smoke test"
  smoke_test || { echo "[pi-cad] reify-asi smoke test failed; re-run with --force" >&2; exit 5; }
  exit 0
fi

# ---- micromamba -------------------------------------------------------------
if [ ! -x "$MICROMAMBA" ]; then
  archive="$(mktemp "${TMPDIR:-/tmp}/pi-cad-micromamba.XXXXXX")"
  trap 'rm -f "$archive"' EXIT
  url="$CHANNEL_URL/linux-64/micromamba-$MICROMAMBA_VERSION-$MICROMAMBA_BUILD.tar.bz2"
  echo "[pi-cad] downloading micromamba $MICROMAMBA_VERSION"
  curl -fsSL "$url" -o "$archive" || { echo "[pi-cad] micromamba download failed" >&2; exit 3; }
  actual="$(sha256_of "$archive")"
  if [ "$actual" != "$MICROMAMBA_SHA256_LINUX_64" ]; then
    echo "[pi-cad] micromamba checksum mismatch (expected $MICROMAMBA_SHA256_LINUX_64, got $actual)" >&2
    exit 3
  fi
  scratch="$(mktemp -d "${TMPDIR:-/tmp}/pi-cad-micromamba-x.XXXXXX")"
  tar -xjf "$archive" -C "$scratch" bin/micromamba
  mv "$scratch/bin/micromamba" "$MICROMAMBA"
  rm -rf "$scratch"
  chmod +x "$MICROMAMBA"
fi

# ---- environment: OCCT 7.6 and the toolchain --------------------------------
export MAMBA_ROOT_PREFIX="$ASI_HOME/mamba-root"
if [ ! -x "$ENV_DIR/bin/cmake" ] || [ ! -f "$ENV_DIR/lib/libTKernel.so.7.6.3" ]; then
  rm -rf "$ENV_DIR"
  if [ -f "$LOCK" ]; then
    echo "[pi-cad] creating reify-asi environment from $(basename "$LOCK") (occt 7.6.3, about 1.5 GB)"
    "$MICROMAMBA" create -y -p "$ENV_DIR" --file "$LOCK" || { echo "[pi-cad] environment creation failed" >&2; exit 4; }
  else
    echo "[pi-cad] warning: no lock file; solving the environment (not reproducible)" >&2
    "$MICROMAMBA" create -y -p "$ENV_DIR" -c conda-forge "occt=7.6" eigen rapidjson cmake make cxx-compiler \
      || { echo "[pi-cad] environment creation failed" >&2; exit 4; }
  fi
fi
CXX="$ENV_DIR/bin/x86_64-conda-linux-gnu-g++"
[ -x "$CXX" ] || { echo "[pi-cad] compiler missing from the environment" >&2; exit 4; }

# The package cache holds every package a second time; the environment is hard-linked.
"$MICROMAMBA" clean --all --yes >/dev/null 2>&1 || true

# ---- Analysis Situs source: pinned archive, checksum, extraction, patch -----
if [ ! -d "$SRC_DIR/asiAlgo" ]; then
  archive="$DOWNLOAD_DIR/AnalysisSitus-v$ASI_VERSION.tar.gz"
  if [ ! -f "$archive" ] || [ "$(sha256_of "$archive")" != "$ASI_ARCHIVE_SHA256" ]; then
    rm -f "$archive"
    echo "[pi-cad] downloading Analysis Situs v$ASI_VERSION (about 545 MB)"
    curl -fsSL "$ASI_ARCHIVE_URL" -o "$archive.part" || { echo "[pi-cad] Analysis Situs download failed" >&2; exit 3; }
    mv "$archive.part" "$archive"
  fi
  actual="$(sha256_of "$archive")"
  if [ "$actual" != "$ASI_ARCHIVE_SHA256" ]; then
    rm -f "$archive"
    echo "[pi-cad] Analysis Situs checksum mismatch (expected $ASI_ARCHIVE_SHA256, got $actual)" >&2
    exit 3
  fi
  rm -rf "$SRC_TOP"
  mkdir -p "$SRC_TOP"
  # Only the source tree and the licence are needed; the archive also holds ~1.5 GB of data and docs.
  tar -xzf "$archive" -C "$SRC_TOP" --strip-components=1 --wildcards '*/src/*' '*/LICENSE' \
    || { echo "[pi-cad] extracting Analysis Situs failed" >&2; exit 6; }
fi
if ! grep -q "$PATCH_MARKER" "$SRC_DIR/asiAlgo/auxiliary/asiAlgo_Utils.cpp"; then
  patch -p1 -d "$SRC_TOP" < "$PATCH" >/dev/null || { echo "[pi-cad] applying $(basename "$PATCH") failed" >&2; exit 6; }
fi

# ---- build ------------------------------------------------------------------
JOBS="$(nproc 2>/dev/null || echo 2)"
build_start="$(date +%s)"
CMAKE="$ENV_DIR/bin/cmake"
rm -rf "$BUILD_DIR"
"$CMAKE" -S "$ROOT/native/reify-asi" -B "$BUILD_DIR" -G "Unix Makefiles" \
  -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_CXX_COMPILER="$CXX" \
  -DCMAKE_PREFIX_PATH="$ENV_DIR" \
  -DASI_SRC="$SRC_DIR" \
  -DEIGEN_INCLUDE_DIR="$ENV_DIR/include/eigen3" \
  > "$ASI_HOME/configure.log" 2>&1 || { echo "[pi-cad] CMake configure failed (see $ASI_HOME/configure.log)" >&2; exit 6; }
"$CMAKE" --build "$BUILD_DIR" -j "$JOBS" > "$ASI_HOME/build.log" 2>&1 \
  || { echo "[pi-cad] build failed (see $ASI_HOME/build.log)" >&2; tail -20 "$ASI_HOME/build.log" >&2; exit 6; }
build_end="$(date +%s)"
export ASI_BUILD_SECONDS=$((build_end - build_start))

# ---- install: real binary plus a wrapper that sets the library path ---------
install -m 755 "$BUILD_DIR/reify-asi" "$BIN_DIR/reify-asi-bin"
cat > "$BIN_DIR/reify-asi" <<WRAP
#!/usr/bin/env bash
# Runs reify-asi with the environment's OCCT 7.6 libraries first on the library path.
HERE="\$(cd "\$(dirname "\$0")" && pwd)"
export LD_LIBRARY_PATH="$ENV_DIR/lib\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
exec "\$HERE/reify-asi-bin" "\$@"
WRAP
chmod +x "$BIN_DIR/reify-asi"

# ---- smoke test and record --------------------------------------------------
smoke_test || { echo "[pi-cad] reify-asi smoke test failed" >&2; exit 5; }
# The build tree and the downloads are not needed at run time.
rm -rf "$BUILD_DIR"
write_runtime_json
echo "[pi-cad] reify-asi installed: $BIN_DIR/reify-asi (build ${ASI_BUILD_SECONDS}s, $JOBS jobs)"

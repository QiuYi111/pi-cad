#!/usr/bin/env bash
# Install k3s inside WSL2 Ubuntu 24.04 (plan 8.2). Safe to run again.
#
# What it does:
#   - installs k3s with traefik disabled, and local-path volumes under $REIFY_VOLUME_DIR
#   - waits for the node and the local-path storage class
#   - copies the kubeconfig to the invoking user's ~/.kube/config (if absent)
#
# What it does NOT do:
#   - does not touch qwen-server.service, the vLLM process, or port 18020
#   - does not run "wsl --shutdown" (do that from Windows, see wslconfig.example)
#
# k3s must not bind port 18020. The script checks this and fails if k3s owns it.
#
# Usage (inside WSL, as the normal user with sudo):
#   sudo bash cloud/deploy/wsl/install-k3s.sh
#   INSTALL_K3S_VERSION=v1.xx.y+k3s1 sudo -E bash cloud/deploy/wsl/install-k3s.sh   # optional pin
set -euo pipefail

VOLUME_DIR="${REIFY_VOLUME_DIR:-/var/lib/reify/volumes}"
K3S_EXEC_FLAGS="--disable traefik --write-kubeconfig-mode 600 --default-local-storage-path ${VOLUME_DIR}"
RESERVED_VLLM_PORT=18020

log() { echo "[reify-k3s] $*"; }
warn() { echo "[reify-k3s] WARNING: $*" >&2; }
die() { echo "[reify-k3s] ERROR: $*" >&2; exit 1; }

[ "$(id -u)" -eq 0 ] || die "run with sudo"
[ -d /run/systemd/system ] || die "systemd is not running in this WSL distro. Enable [boot] systemd=true in /etc/wsl.conf and restart WSL."
[ "$(stat -fc %T /sys/fs/cgroup)" = "cgroup2fs" ] || die "cgroup v2 is required"

warn "port ${RESERVED_VLLM_PORT} belongs to qwen-server (vLLM). k3s must not bind it. Do not run this script while the vLLM service is being changed."

if systemctl is-active --quiet k3s; then
  log "k3s is already running; skipping the installer"
  if ! grep -q -- "--default-local-storage-path" /etc/systemd/system/k3s.service 2>/dev/null; then
    warn "existing k3s service does not set --default-local-storage-path. PVCs will use the default path. Review /etc/systemd/system/k3s.service."
  fi
else
  log "installing k3s (flags: ${K3S_EXEC_FLAGS})"
  curl -sfL https://get.k3s.io | INSTALL_K3S_VERSION="${INSTALL_K3S_VERSION:-}" \
    INSTALL_K3S_EXEC="${K3S_EXEC_FLAGS}" sh -
fi

mkdir -p "${VOLUME_DIR}"
chmod 0755 "${VOLUME_DIR}"

log "waiting for the node"
k3s kubectl wait --for=condition=Ready node --all --timeout=300s >/dev/null

if ! k3s kubectl get storageclass local-path >/dev/null 2>&1; then
  die "storage class local-path is missing"
fi
log "storage class local-path is present"

# Fail if k3s, not vLLM, listens on the reserved port.
listeners="$(ss -ltnp 2>/dev/null || true)"
if awk -v port=":${RESERVED_VLLM_PORT} " 'index($0, port) && /k3s/ { found = 1 } END { exit !found }' <<<"${listeners}"; then
  die "k3s is listening on port ${RESERVED_VLLM_PORT}. Stop and fix the k3s configuration."
fi
if awk -v port=":${RESERVED_VLLM_PORT} " 'index($0, port) { found = 1 } END { exit !found }' <<<"${listeners}"; then
  log "port ${RESERVED_VLLM_PORT} is in use by another process (expected: qwen-server)"
fi

# Kubeconfig for the user who ran sudo. Existing files are left alone.
if [ -n "${SUDO_USER:-}" ] && [ "${SUDO_USER}" != "root" ]; then
  user_home="$(getent passwd "${SUDO_USER}" | cut -d: -f6)"
  if [ -n "${user_home}" ] && [ ! -e "${user_home}/.kube/config" ]; then
    install -d -m 700 -o "${SUDO_USER}" -g "${SUDO_USER}" "${user_home}/.kube"
    install -m 600 -o "${SUDO_USER}" -g "${SUDO_USER}" /etc/rancher/k3s/k3s.yaml "${user_home}/.kube/config"
    log "kubeconfig copied to ${user_home}/.kube/config"
  fi
fi

log "done. k3s version: $(k3s --version | head -1)"
log "next: build and import the workspace image (cloud/image/build.sh --import)"

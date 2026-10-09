#!/usr/bin/env bash
# Build the platform API image and import it into k3s (no registry needed).
#
# Usage:
#   cloud/platform-api/build.sh [--runtime docker|nerdctl] [--no-import]
#
#   --runtime    container CLI (default: docker if present, else nerdctl)
#   --no-import  build only; skip "k3s ctr images import"
#
# Tag: reify/platform-api:<pi-cad short commit>. Put that tag in
# cloud/deploy/k3s/kustomization.yaml (images: newTag). The pods use imagePullPolicy IfNotPresent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME=""
IMPORT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="${2:?--runtime needs a value}"; shift 2 ;;
    --no-import) IMPORT=0; shift ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

REV="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "warning: working tree has uncommitted changes; the tag $REV does not describe them" >&2
fi
TAG="reify/platform-api:$REV"

if [ -z "$RUNTIME" ]; then
  if command -v docker >/dev/null 2>&1; then
    RUNTIME=docker
  elif command -v nerdctl >/dev/null 2>&1; then
    RUNTIME=nerdctl
  else
    echo "need docker or nerdctl on PATH" >&2
    exit 1
  fi
fi

"$RUNTIME" build -f "$ROOT/cloud/platform-api/Dockerfile" -t "$TAG" "$ROOT"

if [ "$IMPORT" = 1 ]; then
  command -v k3s >/dev/null 2>&1 || { echo "k3s not found; cannot import (use --no-import)" >&2; exit 1; }
  "$RUNTIME" save "$TAG" | sudo k3s ctr -n k8s.io images import -
  if ! sudo k3s ctr -n k8s.io images ls -q | grep -Fxq "$TAG"; then
    echo "import finished but $TAG is not listed in k8s.io" >&2
    exit 1
  fi
  echo "imported $TAG into k3s"
fi

echo "image: $TAG"

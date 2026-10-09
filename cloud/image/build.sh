#!/usr/bin/env bash
# Build the workspace image and optionally import it into k3s.
#
# Usage:
#   PRIME_AGENT_REF=<tag-or-commit> cloud/image/build.sh [--runtime docker|nerdctl] [--tag <name:tag>] [--import]
#
#   --runtime   container CLI to use (default: docker if present, else nerdctl)
#   --tag       image tag (default: reify-workspace:<pi-cad short commit>)
#   --import    save the image and import it into k3s (containerd namespace k8s.io).
#               Needs sudo and the k3s binary on this machine.
#
# The import avoids a registry: the pods use imagePullPolicy IfNotPresent.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
RUNTIME=""
TAG=""
IMPORT=0

while [ $# -gt 0 ]; do
  case "$1" in
    --runtime) RUNTIME="${2:?--runtime needs a value}"; shift 2 ;;
    --tag) TAG="${2:?--tag needs a value}"; shift 2 ;;
    --import) IMPORT=1; shift ;;
    -h|--help) sed -n '2,14p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

PRIME_AGENT_REF="${PRIME_AGENT_REF:?set PRIME_AGENT_REF to a tag or commit of QiuYi111/prime-agent}"
REV="$(git -C "$ROOT" rev-parse --short=12 HEAD)"
if [ -n "$(git -C "$ROOT" status --porcelain)" ]; then
  echo "warning: working tree has uncommitted changes; image label $REV does not describe them" >&2
fi
TAG="${TAG:-reify-workspace:$REV}"

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

"$RUNTIME" build \
  -f "$ROOT/cloud/image/Dockerfile" \
  --build-arg "PRIME_AGENT_REF=$PRIME_AGENT_REF" \
  --build-arg "REIFY_REV=$REV" \
  -t "$TAG" \
  "$ROOT"

if [ "$IMPORT" = 1 ]; then
  command -v k3s >/dev/null 2>&1 || { echo "k3s not found; cannot import" >&2; exit 1; }
  "$RUNTIME" save "$TAG" | sudo k3s ctr -n k8s.io images import -
  if ! sudo k3s ctr -n k8s.io images ls -q | grep -Fq "$TAG"; then
    echo "import finished but $TAG is not listed in k8s.io" >&2
    exit 1
  fi
  echo "imported $TAG into k3s"
fi

echo "image: $TAG (pi-cad $REV, prime-agent $PRIME_AGENT_REF)"

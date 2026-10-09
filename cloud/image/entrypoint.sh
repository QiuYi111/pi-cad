#!/bin/sh
# Workspace entrypoint (plan section 6). Runs as uid 1000 under tini.
#
# Environment in:
#   REIFY_PROJECT_IDS    comma-separated project ids (UUIDs)
#   REIFY_HTTPS_PROXY    proxy URL seen from the pod, e.g. http://<windows-host>:7890
#   HOME                 /workspace/home (set by the image)
set -eu
set -f   # no globbing on the project id list

HOME="${HOME:-/workspace/home}"
export HOME

mkdir -p /workspace/projects /workspace/state "$HOME"

# One directory per project. Ids must be plain tokens, so they cannot escape the volume.
for id in $(printf '%s' "${REIFY_PROJECT_IDS:-}" | tr ',' ' '); do
  case "$id" in
    *[!A-Za-z0-9_-]*)
      echo "entrypoint: invalid project id: $id" >&2
      exit 1
      ;;
  esac
  mkdir -p "/workspace/projects/$id" "/workspace/state/$id"
done

# Seed the user home with the default workflow. Existing user files are kept.
seed_dir=/opt/reify/defaults/.pi-cad/workflows
mkdir -p "$HOME/.pi-cad/workflows"
if [ -d "$seed_dir" ]; then
  cp -n "$seed_dir"/. "$HOME/.pi-cad/workflows/" 2>/dev/null || true
fi

# Proxy. Model traffic leaves through the Windows host. Cluster and local
# addresses never go through the proxy.
if [ -n "${REIFY_HTTPS_PROXY:-}" ]; then
  export HTTPS_PROXY="$REIFY_HTTPS_PROXY" https_proxy="$REIFY_HTTPS_PROXY"
  export HTTP_PROXY="$REIFY_HTTPS_PROXY" http_proxy="$REIFY_HTTPS_PROXY"
fi
NO_PROXY="localhost,127.0.0.1,.svc,.cluster.local"
export NO_PROXY no_proxy="$NO_PROXY"

# Gateway runs in the foreground. tini forwards signals to it.
cd /opt/reify/pi-cad/cloud/workspace-gateway
exec npm start

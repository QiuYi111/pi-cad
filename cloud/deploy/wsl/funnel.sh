#!/usr/bin/env bash
# Expose Caddy (127.0.0.1:18443 on compute) through Tailscale Funnel (plan 8.3, step 3).
#
# Run this on the WINDOWS side, where tailscale.exe is logged in.
# Copy the printed command into PowerShell or cmd, or run this script from
# Git Bash or WSL with TAILSCALE_BIN pointing at tailscale.exe.
#
# Usage:
#   bash funnel.sh              print the command and the current status
#   bash funnel.sh --apply      run the command
#   bash funnel.sh --off        turn Funnel off for port 443
#
# Preconditions (done in the tailnet admin console, not by this script):
#   - HTTPS certificates enabled for the tailnet
#   - Funnel allowed for this machine
#   - "tailscale up" done on the machine
set -euo pipefail

TS="${TAILSCALE_BIN:-tailscale}"
TARGET="http://127.0.0.1:18443"
MODE="${1:-print}"

if ! command -v "$TS" >/dev/null 2>&1; then
  echo "tailscale not found. Set TAILSCALE_BIN to the path of tailscale.exe." >&2
  exit 1
fi

case "$MODE" in
  print)
    echo "Run on Windows:"
    echo "  tailscale funnel --bg --https=443 $TARGET"
    echo
    echo "Current status:"
    "$TS" funnel status || true
    ;;
  --apply)
    "$TS" funnel --bg --https=443 "$TARGET"
    echo
    "$TS" funnel status
    echo
    echo "Next: check from a phone on mobile data:"
    echo "  https://<machine>.<tailnet>.ts.net/v1/healthz   (expect 200)"
    echo "  https://<machine>.<tailnet>.ts.net/internal/x   (expect 404)"
    ;;
  --off)
    "$TS" funnel --https=443 off
    ;;
  *)
    echo "unknown argument: $MODE" >&2
    exit 2
    ;;
esac

#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
deb="$root/release/Reify-Linux-amd64.deb"
appimage="$root/release/Reify-Linux-x86_64.AppImage"
test -s "$deb" && test -s "$appimage"
info="$(dpkg-deb --info "$deb")"; contents="$(dpkg-deb --contents "$deb")"
grep -q 'Package: pi-cad-desktop' <<<"$info"
grep -q 'Reify.desktop' <<<"$contents"
grep -q '/icons/hicolor/.*/apps/Reify.png' <<<"$contents"
mode="$(stat -c %a "$appimage")"; chmod +x "$appimage"
extract="$(mktemp -d)"; trap 'rm -rf "$extract"; chmod "$mode" "$appimage"' EXIT
(cd "$extract" && "$appimage" --appimage-extract >/dev/null)
test -x "$extract/squashfs-root/AppRun"
test -f "$extract/squashfs-root/Reify.desktop"
test -f "$extract/squashfs-root/resources/runtime/manifest.json"
sha256sum "$deb" "$appimage" > "$root/release/linux-sha256.txt"
printf 'Verified deb metadata, desktop icon, AppImage runtime payload, and checksums.\n'

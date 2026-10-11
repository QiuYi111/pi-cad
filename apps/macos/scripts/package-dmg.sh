#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."

[[ -d dist/Reify.app ]] || { printf 'Build Reify.app first.\n' >&2; exit 1; }
codesign --verify --deep --strict dist/Reify.app

staging=$(mktemp -d "${TMPDIR:-/tmp}/reify-dmg.XXXXXX")
trap 'rm -rf "$staging"' EXIT
ditto dist/Reify.app "$staging/Reify.app"
ln -s /Applications "$staging/Applications"

output="dist/Reify-macOS-$(uname -m).dmg"
hdiutil create -volname Reify -srcfolder "$staging" -fs HFS+ -format UDZO -ov "$output"
hdiutil verify "$output"
printf 'Built %s/%s\n' "$PWD" "$output"

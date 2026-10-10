#!/bin/bash
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .build/manual dist/Reify.app/Contents/MacOS
sdk="${REIFY_MACOS_SDK:-$(xcrun --show-sdk-path)}"
# Prefer the stable SDK when a beta SDK is selected by Command Line Tools.
if [[ -z "${REIFY_MACOS_SDK:-}" && -d "$sdk/../MacOSX26.sdk" ]]; then sdk="$sdk/../MacOSX26.sdk"; fi
# swiftc also works on Macs with Command Line Tools only (no Xcode required).
swiftc -sdk "$sdk" -target "$(uname -m)-apple-macosx14.0" -parse-as-library -swift-version 5 -module-name ReifyCloud -emit-library -emit-module \
  Sources/ReifyCloud/*.swift -emit-module-path .build/manual/ReifyCloud.swiftmodule \
  -o .build/manual/libReifyCloud.dylib -Xlinker -install_name -Xlinker @rpath/libReifyCloud.dylib
swiftc -sdk "$sdk" -target "$(uname -m)-apple-macosx14.0" -parse-as-library -swift-version 5 -I .build/manual -L .build/manual -lReifyCloud \
  Sources/Reify/*.swift -o dist/Reify.app/Contents/MacOS/Reify -Xlinker -rpath -Xlinker @executable_path/../Frameworks
mkdir -p dist/Reify.app/Contents/Frameworks
cp .build/manual/libReifyCloud.dylib dist/Reify.app/Contents/Frameworks/
cp Info.plist dist/Reify.app/Contents/Info.plist
mkdir -p dist/Reify.app/Contents/Resources
swiftc -sdk "$sdk" scripts/make-icon.swift -o .build/manual/make-icon
.build/manual/make-icon ../desktop/build/icon.png .build/manual/AppIcon.iconset
iconutil -c icns .build/manual/AppIcon.iconset -o dist/Reify.app/Contents/Resources/AppIcon.icns
cp Sources/Reify/Resources/* dist/Reify.app/Contents/Resources/
node scripts/build-desktop-presentation.mjs .build/manual/DesktopPresentation.js
cp .build/manual/DesktopPresentation.js dist/Reify.app/Contents/Resources/
cp .build/manual/DesktopThirdParty.txt dist/Reify.app/Contents/Resources/
codesign --force --sign - dist/Reify.app/Contents/Frameworks/libReifyCloud.dylib
codesign --force --sign - dist/Reify.app
swiftc -sdk "$sdk" -target "$(uname -m)-apple-macosx14.0" -parse-as-library -swift-version 5 -I .build/manual -L .build/manual -lReifyCloud \
  Sources/ReifyE2E/*.swift -o .build/manual/ReifyE2E -Xlinker -rpath -Xlinker @executable_path
flow_sources=()
for source in Sources/Reify/*.swift; do
  [[ "$source" == Sources/Reify/ReifyApp.swift ]] || flow_sources+=("$source")
done
swiftc -sdk "$sdk" -target "$(uname -m)-apple-macosx14.0" -parse-as-library -swift-version 5 -I .build/manual -L .build/manual -lReifyCloud \
  "${flow_sources[@]}" Sources/ReifyFlowE2E/*.swift -o .build/manual/ReifyFlowE2E -Xlinker -rpath -Xlinker @executable_path
ditto -c -k --sequesterRsrc --keepParent dist/Reify.app "dist/Reify-macOS-$(uname -m).zip"
bash scripts/package-dmg.sh
printf 'Built %s/dist/Reify.app\n' "$PWD"

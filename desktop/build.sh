#!/usr/bin/env bash
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd -P)"
core="$HOME/.agents/skills/design-memory"
app="${TASTE_APP_DIR:-$HOME/Applications}/Taste.app"
version="$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$here/../package.json")"

if [[ "$(uname)" != "Darwin" ]]; then
  echo 'The Taste desktop app is macOS only. Use `taste open` instead.' >&2
  exit 1
fi
if ! xcrun --find swiftc >/dev/null 2>&1; then
  echo 'Swift is required to build the app. Run: xcode-select --install' >&2
  exit 1
fi
bun="$(command -v bun)"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
mkdir -p "$work/Taste.app/Contents/MacOS" "$work/Taste.app/Contents/Resources"

xcrun swiftc -O -o "$work/make-icon" "$here/make-icon.swift"
"$work/make-icon" "$work/Taste.iconset"
iconutil -c icns "$work/Taste.iconset" -o "$work/Taste.app/Contents/Resources/Taste.icns"

xcrun swiftc -O -o "$work/Taste.app/Contents/MacOS/Taste" "$here/Taste.swift" -framework AppKit -framework WebKit

cat > "$work/Taste.app/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Taste</string>
  <key>CFBundleDisplayName</key><string>Taste</string>
  <key>CFBundleIdentifier</key><string>dev.taste.desktop</string>
  <key>CFBundleExecutable</key><string>Taste</string>
  <key>CFBundleIconFile</key><string>Taste</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>${version}</string>
  <key>CFBundleVersion</key><string>${version}</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.graphics-design</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
  <key>TasteBun</key><string>${bun}</string>
  <key>TasteMain</key><string>${core}/src/main.ts</string>
</dict>
</plist>
PLIST

codesign --force --sign - "$work/Taste.app" >/dev/null 2>&1
mkdir -p "$(dirname "$app")"
rm -rf "$app"
mv "$work/Taste.app" "$app"
echo "Desktop app: $app"

#!/usr/bin/env bash
# Creates a native macOS Application bundle on the Desktop with custom icon
set -e

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$HOME/Desktop"
APP_NAME="MCP Tunnel 账户管理器"
APP_DIR="$DESKTOP_DIR/$APP_NAME.app"
ICON_SRC="$PROJECT_DIR/resources/mcp-tunnel.icns"

if [ ! -d "$DESKTOP_DIR" ]; then
  echo "Desktop directory not found at $DESKTOP_DIR"
  exit 1
fi

rm -rf "$APP_DIR"
mkdir -p "$APP_DIR/Contents/MacOS"
mkdir -p "$APP_DIR/Contents/Resources"

# Copy or generate icon
if [ -f "$ICON_SRC" ]; then
  cp "$ICON_SRC" "$APP_DIR/Contents/Resources/AppIcon.icns"
else
  # If icns missing, generate from template ico
  ICO_SRC="$PROJECT_DIR/packaging/windows/templates/kit/oneclick/mcp-tunnel.ico"
  if [ -f "$ICO_SRC" ]; then
    TMP_PNG="/tmp/mcp-icon-install.png"
    sips -s format png "$ICO_SRC" --out "$TMP_PNG" >/dev/null 2>&1
    TMP_ICONSET="/tmp/AppIcon.iconset"
    mkdir -p "$TMP_ICONSET"
    sips -z 16 16     "$TMP_PNG" --out "$TMP_ICONSET/icon_16x16.png" >/dev/null 2>&1
    sips -z 32 32     "$TMP_PNG" --out "$TMP_ICONSET/icon_16x16@2x.png" >/dev/null 2>&1
    sips -z 32 32     "$TMP_PNG" --out "$TMP_ICONSET/icon_32x32.png" >/dev/null 2>&1
    sips -z 64 64     "$TMP_PNG" --out "$TMP_ICONSET/icon_32x32@2x.png" >/dev/null 2>&1
    sips -z 128 128   "$TMP_PNG" --out "$TMP_ICONSET/icon_128x128.png" >/dev/null 2>&1
    sips -z 256 256   "$TMP_PNG" --out "$TMP_ICONSET/icon_128x128@2x.png" >/dev/null 2>&1
    sips -z 256 256   "$TMP_PNG" --out "$TMP_ICONSET/icon_256x256.png" >/dev/null 2>&1
    sips -z 512 512   "$TMP_PNG" --out "$TMP_ICONSET/icon_256x256@2x.png" >/dev/null 2>&1
    sips -z 512 512   "$TMP_PNG" --out "$TMP_ICONSET/icon_512x512.png" >/dev/null 2>&1
    sips -z 1024 1024 "$TMP_PNG" --out "$TMP_ICONSET/icon_512x512@2x.png" >/dev/null 2>&1
    iconutil -c icns "$TMP_ICONSET" -o "$APP_DIR/Contents/Resources/AppIcon.icns"
    rm -rf "$TMP_ICONSET" "$TMP_PNG"
  fi
fi

# Write Info.plist
cat > "$APP_DIR/Contents/Info.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleName</key>
    <string>$APP_NAME</string>
    <key>CFBundleDisplayName</key>
    <string>$APP_NAME</string>
    <key>CFBundleIdentifier</key>
    <string>com.mcptunnel.accountmanager</string>
    <key>CFBundleVersion</key>
    <string>1.0.0</string>
    <key>CFBundleShortVersionString</key>
    <string>1.0.0</string>
    <key>CFBundleExecutable</key>
    <string>launcher</string>
    <key>CFBundleIconFile</key>
    <string>AppIcon</string>
    <key>LSMinimumSystemVersion</key>
    <string>12.0</string>
    <key>NSHighResolutionCapable</key>
    <true/>
</dict>
</plist>
EOF

# Write launcher
cat > "$APP_DIR/Contents/MacOS/launcher" << EOF
#!/usr/bin/env bash
export PATH="/usr/local/bin:/opt/homebrew/bin:\$HOME/.local/bin:\$HOME/.gemini/antigravity/bin:\$PATH"

PROJECT_DIR="$PROJECT_DIR"
cd "\$PROJECT_DIR" || exit 1

./start-manager.sh

osascript -e 'display notification "控制台已启动并在浏览器中打开 http://127.0.0.1:17642" with title "$APP_NAME"' >/dev/null 2>&1 || true
EOF

chmod +x "$APP_DIR/Contents/MacOS/launcher"
xattr -cr "$APP_DIR" 2>/dev/null || true
touch "$APP_DIR"

echo "Native Desktop Application created successfully at:"
echo "$APP_DIR"

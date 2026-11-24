#!/usr/bin/env bash
# install-tunnel-client.sh - Download and install official OpenAI tunnel-client on macOS / Linux
set -e

VERSION="0.0.19"
TARGET_DIR="${1:-$HOME/.openai-tunnel}"

# Detect OS and Architecture
OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
ARCH="$(uname -m)"

case "$ARCH" in
  arm64|aarch64)
    ARCH_NAME="arm64"
    ;;
  x86_64|amd64)
    ARCH_NAME="amd64"
    ;;
  *)
    echo "Unsupported architecture: $ARCH"
    exit 1
    ;;
esac

case "$OS" in
  darwin)
    PLATFORM="darwin-$ARCH_NAME"
    ;;
  linux)
    PLATFORM="linux-$ARCH_NAME"
    ;;
  *)
    echo "Unsupported operating system: $OS"
    exit 1
    ;;
esac

ASSET_NAME="tunnel-client-v${VERSION}-${PLATFORM}.zip"
DOWNLOAD_URL="https://github.com/openai/tunnel-client/releases/download/v${VERSION}/${ASSET_NAME}"

echo "=== OpenAI Tunnel Client Installer ==="
echo "Target: $TARGET_DIR"
echo "Platform: $PLATFORM"
echo "Version: v$VERSION"
echo "Download URL: $DOWNLOAD_URL"
echo ""

mkdir -p "$TARGET_DIR"
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

echo "Downloading ${ASSET_NAME}..."
curl -f -L -o "$TMP_DIR/${ASSET_NAME}" "$DOWNLOAD_URL"

echo "Extracting binaries..."
unzip -q -o "$TMP_DIR/${ASSET_NAME}" -d "$TARGET_DIR"

# Ensure binaries have executable permissions
chmod +x "$TARGET_DIR/tunnel-client" 2>/dev/null || true
if [ -f "$TARGET_DIR/cloudflared" ]; then
  chmod +x "$TARGET_DIR/cloudflared" 2>/dev/null || true
fi

# Clear macOS quarantine attribute if present
if command -v xattr >/dev/null 2>&1; then
  xattr -d com.apple.quarantine "$TARGET_DIR/tunnel-client" 2>/dev/null || true
  if [ -f "$TARGET_DIR/cloudflared" ]; then
    xattr -d com.apple.quarantine "$TARGET_DIR/cloudflared" 2>/dev/null || true
  fi
fi

echo ""
echo "Installation complete!"
echo "Installed to: $TARGET_DIR"
if [ -x "$TARGET_DIR/tunnel-client" ]; then
  echo "tunnel-client binary: $TARGET_DIR/tunnel-client"
  echo "Version check: $($TARGET_DIR/tunnel-client --version 2>&1 || echo 'executable ready')"
fi
if [ -x "$TARGET_DIR/cloudflared" ]; then
  echo "cloudflared binary: $TARGET_DIR/cloudflared"
  echo "Cloudflared version: $($TARGET_DIR/cloudflared --version 2>&1 | head -n 1 || echo 'executable ready')"
fi
echo ""
echo "MCP Tunnel Account Manager will now automatically detect and use this binary."

#!/usr/bin/env bash
# install-overleaf-mcp.sh - Install Overleaf MCP server on macOS / Linux
set -e

OVERLEAF_DIR="$HOME/.overleaf-mcp/runtime"
BIN_DIR="$HOME/.local/bin"
VERSION="0.3.9"

echo "=== Overleaf MCP Server Installer ==="
echo "Target directory: $OVERLEAF_DIR"
echo "Package: mcp-server-overleaf@$VERSION"

mkdir -p "$OVERLEAF_DIR"
mkdir -p "$BIN_DIR"

cd "$OVERLEAF_DIR"
if [ ! -f "package.json" ]; then
  npm init -y >/dev/null 2>&1
fi

echo "Installing mcp-server-overleaf..."
npm install "mcp-server-overleaf@$VERSION" --save >/dev/null 2>&1

# Symlink CLI binary to ~/.local/bin
if [ -f "$OVERLEAF_DIR/node_modules/.bin/mcp-server-overleaf" ]; then
  ln -sf "$OVERLEAF_DIR/node_modules/.bin/mcp-server-overleaf" "$BIN_DIR/mcp-server-overleaf"
fi

# Ensure default template overleaf.yaml exists in tunnel-client config directory
CONFIG_DIR="$HOME/Library/Application Support/tunnel-client"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/overleaf.yaml" ]; then
  cat << EOF > "$CONFIG_DIR/overleaf.yaml"
config_version: 1
control_plane:
  base_url: "https://api.openai.com"
  tunnel_id: ""
  api_key: "env:CONTROL_PLANE_API_KEY"
health:
  listen_addr: "127.0.0.1:0"
admin_ui:
  open_browser: false
log:
  level: info
  format: json
mcp:
  commands:
    - channel: main
      command: "node $OVERLEAF_DIR/node_modules/mcp-server-overleaf/dist/index.js --stdio"
EOF
fi

echo ""
echo "Installation complete!"
echo "Overleaf MCP binary: $BIN_DIR/mcp-server-overleaf"
echo "Entry script: $OVERLEAF_DIR/node_modules/mcp-server-overleaf/dist/index.js"
echo "Installed version: $($BIN_DIR/mcp-server-overleaf --version 2>&1 || echo 'ready')"
echo ""
echo "You can now connect to Overleaf MCP either directly (via Claude/Cursor/ChatGPT Desktop)"
echo "or remotely via OpenAI Secure Tunnel in the MCP Tunnel Account Manager."

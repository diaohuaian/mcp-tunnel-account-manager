#!/usr/bin/env bash
# install-antigravity-mcp.sh - Install Antigravity MCP server on macOS / Linux
set -e

INSTALL_DIR="$HOME/.antigravity-mcp"
BIN_DIR="$HOME/.local/bin"
REPO_URL="https://github.com/Kio-pon/antigravity-mcp.git"

echo "=== Antigravity MCP Server Installer ==="
echo "Target directory: $INSTALL_DIR"
echo "Repository: $REPO_URL"

# Check Python 3
if ! command -v python3 >/dev/null 2>&1; then
  echo "Error: python3 is required but was not found in PATH."
  exit 1
fi

PY_VER=$(python3 -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')")
PY_MAJOR=$(echo "$PY_VER" | cut -d. -f1)
PY_MINOR=$(echo "$PY_VER" | cut -d. -f2)
if [ "$PY_MAJOR" -lt 3 ] || { [ "$PY_MAJOR" -eq 3 ] && [ "$PY_MINOR" -lt 9 ]; }; then
  echo "Error: Python 3.9+ is required. Found Python $PY_VER"
  exit 1
fi

mkdir -p "$BIN_DIR"

if [ -d "$INSTALL_DIR/.git" ]; then
  echo "Updating existing repository in $INSTALL_DIR..."
  cd "$INSTALL_DIR" && git pull --quiet
else
  echo "Cloning $REPO_URL into $INSTALL_DIR..."
  git clone --quiet "$REPO_URL" "$INSTALL_DIR"
fi

# Create launcher script in ~/.local/bin
cat << 'EOF' > "$BIN_DIR/antigravity-mcp"
#!/usr/bin/env bash
# antigravity-mcp launcher
export PYTHONPATH="$HOME/.antigravity-mcp/src${PYTHONPATH:+:$PYTHONPATH}"
exec /usr/bin/python3 -c "import sys; from antigravity_mcp.server import main; main()" "$@"
EOF
chmod +x "$BIN_DIR/antigravity-mcp"

# Create symlink inside project bin/ if available
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_BIN="$(cd "$SCRIPT_DIR/.." && pwd)/bin"
if [ -d "$PROJECT_BIN" ]; then
  ln -sf "$BIN_DIR/antigravity-mcp" "$PROJECT_BIN/antigravity-mcp"
fi

# Ensure default template antigravity-local.yaml exists in tunnel-client config directory
CONFIG_DIR="$HOME/Library/Application Support/tunnel-client"
mkdir -p "$CONFIG_DIR"
if [ ! -f "$CONFIG_DIR/antigravity-local.yaml" ]; then
  cat << 'EOF' > "$CONFIG_DIR/antigravity-local.yaml"
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
      command: "antigravity-mcp"
EOF
fi

echo ""
echo "Installation complete!"
echo "Launcher binary: $BIN_DIR/antigravity-mcp"
echo "Repository source: $INSTALL_DIR/src/antigravity_mcp"
echo ""
echo "You can now connect to Antigravity MCP either directly (via Claude/Cursor/ChatGPT Desktop)"
echo "or remotely via OpenAI Secure Tunnel in the MCP Tunnel Account Manager."

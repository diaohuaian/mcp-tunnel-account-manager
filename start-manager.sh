#!/usr/bin/env bash
# MCP Tunnel Account Manager - macOS / Linux Launcher
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

export PATH="$SCRIPT_DIR/bin:$PATH"

PORT="${PORT:-17642}"
DATA_DIR="${DATA_DIR:-$HOME/Library/Application Support/McpTunnelAccountManager}"
HOST="127.0.0.1"
FOREGROUND=false
STOP=false
NO_BROWSER=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --foreground|-f)
      FOREGROUND=true
      shift
      ;;
    --stop)
      STOP=true
      shift
      ;;
    --port|-p)
      PORT="$2"
      shift 2
      ;;
    --data-dir|-d)
      DATA_DIR="$2"
      shift 2
      ;;
    --no-browser)
      NO_BROWSER=true
      shift
      ;;
    --help|-h)
      echo "Usage: ./start-manager.sh [options]"
      echo ""
      echo "Options:"
      echo "  --foreground, -f    Run manager in foreground"
      echo "  --stop              Stop running manager"
      echo "  --port, -p <port>   Set listening port (default: 17642)"
      echo "  --data-dir, -d <dir> Set data directory"
      echo "  --no-browser        Do not automatically open browser"
      echo "  --help, -h          Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $1"
      exit 1
      ;;
  esac
done

# Check Node.js
if ! command -v node >/dev/null 2>&1; then
  echo "Error: Node.js >= 22.14.0 is required, but 'node' was not found in PATH."
  echo "Please install Node.js from https://nodejs.org or via 'brew install node'."
  exit 1
fi

NODE_VERSION=$(node -v | sed 's/^v//')
NODE_MAJOR=$(echo "$NODE_VERSION" | cut -d. -f1)
NODE_MINOR=$(echo "$NODE_VERSION" | cut -d. -f2)

if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 14 ]; }; then
  echo "Error: Node.js >= 22.14.0 is required. Current version: v$NODE_VERSION"
  exit 1
fi

mkdir -p "$DATA_DIR"
PID_FILE="$DATA_DIR/console-$PORT.pid.json"
LOG_FILE="$DATA_DIR/console-$PORT.log"

get_running_pid() {
  if [ -f "$PID_FILE" ]; then
    PID=$(node -e "try { const d = JSON.parse(fs.readFileSync('$PID_FILE', 'utf8')); console.log(d.pid || d.processId || ''); } catch (_) {}" 2>/dev/null)
    if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
      echo "$PID"
      return 0
    fi
  fi
  # Fallback check lsof for listening port
  PORT_PID=$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | awk 'NR>1 {print $2}' | head -n 1)
  if [ -n "$PORT_PID" ]; then
    echo "$PORT_PID"
    return 0
  fi
  return 1
}

# Stop action
if [ "$STOP" = true ]; then
  RUNNING_PID=$(get_running_pid || true)
  if [ -n "$RUNNING_PID" ]; then
    echo "Stopping MCP Tunnel Account Manager (PID: $RUNNING_PID)..."
    kill "$RUNNING_PID" 2>/dev/null || true
    for i in {1..20}; do
      if ! kill -0 "$RUNNING_PID" 2>/dev/null; then
        break
      fi
      sleep 0.1
    done
    if kill -0 "$RUNNING_PID" 2>/dev/null; then
      kill -9 "$RUNNING_PID" 2>/dev/null || true
    fi
    rm -f "$PID_FILE"
    echo "Console stopped."
  else
    echo "No running console found on port $PORT."
  fi
  exit 0
fi

# Check if already running
RUNNING_PID=$(get_running_pid || true)
if [ -n "$RUNNING_PID" ]; then
  echo "MCP Tunnel Account Manager is already running on http://$HOST:$PORT (PID: $RUNNING_PID)"
  if [ "$NO_BROWSER" = false ]; then
    if command -v open >/dev/null 2>&1; then
      open "http://$HOST:$PORT"
    fi
  fi
  exit 0
fi

export PORT
export DATA_DIR
export HOST

if [ "$FOREGROUND" = true ]; then
  echo "Starting MCP Tunnel Account Manager in foreground..."
  exec node scripts/launch-manager.mjs
fi

# Background daemon start
echo "Starting MCP Tunnel Account Manager on http://$HOST:$PORT..."
nohup node scripts/launch-manager.mjs < /dev/null >> "$LOG_FILE" 2>&1 &
BG_PID=$!
disown "$BG_PID" 2>/dev/null || true

# Record PID
node -e "
import fs from 'node:fs';
fs.writeFileSync('$PID_FILE', JSON.stringify({
  processId: $BG_PID,
  pid: $BG_PID,
  port: $PORT,
  startedAt: new Date().toISOString()
}, null, 2));
"

# Wait for readiness
URL="http://$HOST:$PORT"
READY=false
for i in {1..50}; do
  if curl -s -f "$URL/api/auth/state" >/dev/null 2>&1; then
    READY=true
    break
  fi
  if ! kill -0 "$BG_PID" 2>/dev/null; then
    echo "Error: Manager process exited prematurely. Log output:"
    cat "$LOG_FILE"
    rm -f "$PID_FILE"
    exit 1
  fi
  sleep 0.2
done

if [ "$READY" = true ]; then
  echo "=========================================================="
  echo " MCP Tunnel Account Manager ready!"
  echo " Web UI: $URL"
  echo " Data Directory: $DATA_DIR"
  if [ -f "$DATA_DIR/bootstrap-code.txt" ]; then
    echo " Bootstrap Code: $(cat "$DATA_DIR/bootstrap-code.txt")"
    echo " (Use this code to set up your administrator password on first visit)"
  fi
  echo " Log File: $LOG_FILE"
  echo "=========================================================="

  if [ "$NO_BROWSER" = false ]; then
    if command -v open >/dev/null 2>&1; then
      open "$URL"
    elif command -v xdg-open >/dev/null 2>&1; then
      xdg-open "$URL"
    fi
  fi
else
  echo "Warning: Manager started (PID: $BG_PID) but did not respond on $URL within 10 seconds."
  echo "Check $LOG_FILE for details."
fi

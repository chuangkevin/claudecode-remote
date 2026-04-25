#!/usr/bin/env bash
# claudecode-remote — Mac manual start
# Starts server in background (use install.sh for persistent launchd service)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PORT="${PORT:-9224}"

# Kill any existing process on the port
PID="$(lsof -ti ":$PORT" 2>/dev/null || true)"
if [[ -n "$PID" ]]; then
    echo "Stopping existing process (PID $PID)..."
    kill -9 "$PID" 2>/dev/null || true
    sleep 1
fi

NODE_BIN="$(command -v node)"
cd "$PROJECT_ROOT"
nohup "$NODE_BIN" --env-file=.env packages/server/dist/index.js \
    >> "$PROJECT_ROOT/server.log" 2>&1 &
SERVER_PID=$!

echo "✓ Server started (PID $SERVER_PID) on port $PORT"
echo "  Logs: $PROJECT_ROOT/server.log"

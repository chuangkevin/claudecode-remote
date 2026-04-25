#!/usr/bin/env bash
# claudecode-remote — Mac manual stop
set -euo pipefail

PORT="${PORT:-9224}"

PID="$(lsof -ti ":$PORT" 2>/dev/null || true)"
if [[ -n "$PID" ]]; then
    kill -9 "$PID" 2>/dev/null || true
    echo "✓ Server stopped (PID $PID)"
else
    echo "  No server running on port $PORT"
fi

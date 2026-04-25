#!/usr/bin/env bash
# claudecode-remote — Mac one-click uninstall
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PORT="${PORT:-9224}"
PLIST_LABEL="com.claudecode-remote"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

step() { echo; echo ">> $1"; }
ok()   { echo "   ✓ $1"; }
skip() { echo "   - $1"; }

echo "╔══════════════════════════════════════╗"
echo "║   ClaudeCode Remote — Mac Remove     ║"
echo "╚══════════════════════════════════════╝"

# ── 1. Unload launchd service ─────────────────────────────────────────────────
step "Unloading launchd service"
if [[ -f "$PLIST_PATH" ]]; then
    launchctl unload "$PLIST_PATH" 2>/dev/null || true
    rm -f "$PLIST_PATH"
    ok "Service unloaded and plist removed"
else
    skip "Plist not found at $PLIST_PATH"
fi

# ── 2. Kill remaining process on port ─────────────────────────────────────────
step "Stopping server process"
PID="$(lsof -ti ":$PORT" 2>/dev/null || true)"
if [[ -n "$PID" ]]; then
    kill -9 "$PID" 2>/dev/null || true
    ok "Process PID $PID killed"
else
    skip "No process listening on port $PORT"
fi

# ── Done ──────────────────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════╗"
echo "║         Uninstall complete!          ║"
echo "╚══════════════════════════════════════╝"
echo "   Note: node_modules/ and dist/ are not removed."
echo "   Delete them manually for a full clean."

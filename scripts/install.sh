#!/usr/bin/env bash
# claudecode-remote — Mac one-click install
# Usage: bash scripts/install.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(dirname "$SCRIPT_DIR")"
PORT="${PORT:-9224}"
PLIST_LABEL="com.claudecode-remote"
PLIST_PATH="$HOME/Library/LaunchAgents/$PLIST_LABEL.plist"

step() { echo; echo ">> $1"; }
ok()   { echo "   ✓ $1"; }
warn() { echo "   ⚠ $1"; }
fail() { echo "   ✗ $1"; exit 1; }

echo "╔══════════════════════════════════════╗"
echo "║    ClaudeCode Remote — Mac Setup     ║"
echo "╚══════════════════════════════════════╝"
echo "   Project: $PROJECT_ROOT"

# ── 1. Prerequisites ──────────────────────────────────────────────────────────
step "Checking prerequisites"
command -v node &>/dev/null || fail "Node.js not found — install via: brew install node"
NODE_BIN="$(command -v node)"
NODE_VER="$(node --version)"
command -v git  &>/dev/null || fail "Git not found"
ok "Node $NODE_VER at $NODE_BIN, Git $(git --version | head -1)"

# ── 2. .env ───────────────────────────────────────────────────────────────────
step "Checking .env"
ENV_FILE="$PROJECT_ROOT/.env"
if [[ ! -f "$ENV_FILE" ]]; then
    if [[ -f "$PROJECT_ROOT/.env.example" ]]; then
        cp "$PROJECT_ROOT/.env.example" "$ENV_FILE"
        warn ".env created from .env.example — review it before first use"
    else
        echo "PORT=$PORT" > "$ENV_FILE"
        warn "Minimal .env created — edit $ENV_FILE as needed"
    fi
else
    ok ".env exists"
fi

# ── 3. npm install ────────────────────────────────────────────────────────────
step "Installing npm dependencies"
cd "$PROJECT_ROOT"
npm install --silent
ok "Dependencies installed"

# ── 4. Build ──────────────────────────────────────────────────────────────────
step "Building server + web"
npm run build
ok "Build complete"

# ── 5. Create launchd plist ───────────────────────────────────────────────────
step "Creating launchd plist"
mkdir -p "$HOME/Library/LaunchAgents"

# Unload existing service first (ignore errors)
launchctl unload "$PLIST_PATH" 2>/dev/null || true
[[ -f "$PLIST_PATH" ]] && rm -f "$PLIST_PATH"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${PLIST_LABEL}</string>

    <key>ProgramArguments</key>
    <array>
        <string>${NODE_BIN}</string>
        <string>--env-file=.env</string>
        <string>${PROJECT_ROOT}/packages/server/dist/index.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>${PROJECT_ROOT}</string>

    <!-- Start immediately and on every login -->
    <key>RunAtLoad</key>
    <true/>

    <!-- Auto-restart on crash (launchd built-in watchdog) -->
    <key>KeepAlive</key>
    <true/>

    <!-- Throttle rapid restarts: wait 5s between attempts -->
    <key>ThrottleInterval</key>
    <integer>5</integer>

    <key>StandardOutPath</key>
    <string>${PROJECT_ROOT}/server.log</string>
    <key>StandardErrorPath</key>
    <string>${PROJECT_ROOT}/server-error.log</string>
</dict>
</plist>
PLIST

ok "Plist written to $PLIST_PATH"

# ── 6. Load service ───────────────────────────────────────────────────────────
step "Loading launchd service"
launchctl load "$PLIST_PATH"
ok "Service loaded (auto-restarts on crash, starts on login)"

# ── 7. Health check ───────────────────────────────────────────────────────────
step "Verifying health"
HEALTH_URL="http://localhost:$PORT/api/health"
for i in $(seq 1 15); do
    if curl -sf "$HEALTH_URL" &>/dev/null; then
        BODY="$(curl -s "$HEALTH_URL")"
        ok "$HEALTH_URL → $BODY"
        break
    fi
    sleep 1
    if [[ $i -eq 15 ]]; then
        fail "Health check failed after 15s — check $PROJECT_ROOT/server.log"
    fi
done

# ── Done ──────────────────────────────────────────────────────────────────────
echo
echo "╔══════════════════════════════════════╗"
echo "║          Install complete!           ║"
echo "╚══════════════════════════════════════╝"
echo "   URL:        http://localhost:$PORT"
echo "   Logs:       $PROJECT_ROOT/server.log"
echo "   Start:      bash scripts/start.sh"
echo "   Stop:       bash scripts/stop.sh"
echo "   Uninstall:  bash scripts/uninstall.sh"

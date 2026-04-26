# claudecode-remote — AI Assistant Rules

## Project Overview

Web interface for Claude Code CLI. Lets users access Claude Code from any device (phone, tablet, browser). Supports real-time streaming, image upload, session management, persistent CLI processes per session, and multi-agent task dispatch.

## Architecture

- **Backend**: Fastify + `@fastify/websocket` on port 9224; SQLite for persistence
- **Frontend**: React + Vite + Tailwind CSS (`packages/web/src/App.tsx`)
- **Chat bridge**: `packages/server/src/claude.ts` — persistent CLI process pool, one per session
- **Task bridge**: `packages/server/src/task-manager.ts` — up to 20 parallel agents, each in a git worktree

## Key Files

| File | Purpose |
|---|---|
| `packages/server/src/index.ts` | Fastify entry, REST API routes |
| `packages/server/src/websocket.ts` | WS handler (chat, resume, cancel, task event fanout) |
| `packages/server/src/claude.ts` | Chat CLI pool, 5-min idle timeout |
| `packages/server/src/task-manager.ts` | Task agent pool, worktree lifecycle, EventEmitter |
| `packages/server/src/store.ts` | In-memory session state, broadcast |
| `packages/server/src/db.ts` | SQLite schema + CRUD (sessions, messages, tasks, task_messages) |
| `packages/web/src/App.tsx` | Full React SPA |

## Key Design Decisions

- `--no-session-persistence`: avoids Windows session lock; sessions tracked in DB, not `~/.claude/projects/`
- Persistent CLI process per session: messages written to stdin, resolved on `type: "result"` event; 5-min idle kill
- History injection: only on first message of freshly spawned process (`buildMessageText`)
- Default system prompt: `DEFAULT_SYSTEM_PROMPT` in `claude.ts`; user override in Settings replaces entirely
- Task agents: each spawns its own CLI process in a git worktree; `KeepAlive` not applicable (single run)
- Task events fan-out: `taskEvents` EventEmitter → subscribed per WS connection → forwarded as `task:*` messages

## Task Dispatch Design

Task dispatch is AI-driven — Claude decides when to spin up sub-agents based on conversation context. The backend API (`POST /api/tasks`) is the integration point; Claude CLI calls it via tool use or direct HTTP. Do **not** add manual dispatch UI to the frontend.

## Development Rules

- Read current code before changing anything
- Prefer smallest correct fix; no refactors beyond the task
- No magic numbers — use named constants
- No silent fallbacks — surface errors to the user
- Every code change: build → commit → push (do not skip)

## Build & Deploy

```bash
npm install          # install all workspace deps
npm run build        # build server (tsc) + web (vite)
```

**Windows**: `.\start-hidden.ps1` / `.\stop.ps1`
**Mac**: `bash scripts/start.sh` / `bash scripts/stop.sh`
**Full install**: `scripts/install.ps1` (Win) or `bash scripts/install.sh` (Mac)

**Windows watchdog**: Task Scheduler runs `wscript.exe watchdog.vbs` every minute.
`watchdog.vbs` is a silent VBScript wrapper — it invokes `watchdog.ps1` with `-WindowStyle Hidden`
via `WshShell.Run(..., 0, False)` so no PowerShell window ever flashes.

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 9224 | Server port |
| `HOST` | 0.0.0.0 | Listen address |
| `WORKSPACE_ROOT` | `process.cwd()` | Default Claude working directory |
| `CLAUDE_DATA_DIR` | `~/.claude` | DB + auth storage |
| `CLAUDE_CODE_OAUTH_TOKEN` | — | Long-lived OAuth token (recommended for headless server use) |

## Authentication

The server spawns Claude Code CLI as child processes. Auth is inherited from the environment.

**Recommended (headless / server):** Set `CLAUDE_CODE_OAUTH_TOKEN` in `.env`.
This is a long-lived token (1 year) obtained via `claude setup-token`. It does not expire daily like the browser OAuth flow.

**Check auth before start:** `check-auth.ps1` runs as a pre-flight from `start-hidden.ps1`. It warns if `claudeAiOauth.expiresAt` in `~/.claude/.credentials.json` is expired or <24 h, but does not block the start when `CLAUDE_CODE_OAUTH_TOKEN` is in use (no credentials file needed).

**If you see `AUTH_401` in server logs:**
```powershell
claude setup-token   # generates a new CLAUDE_CODE_OAUTH_TOKEN
# then update .env with the new token and restart
.\stop.ps1; .\start-hidden.ps1
```

## API Surface

**Sessions**
- `GET  /api/sessions` — list all
- `PATCH /api/sessions/:id/rename` — rename
- `PATCH /api/sessions/:id/pin` — pin/unpin

**Tasks**
- `POST   /api/tasks` — create agent task `{ repoPath?, prompt }`
- `GET    /api/tasks` — list all tasks
- `DELETE /api/tasks/:id` — cancel + cleanup
- `GET    /api/tasks/:id/transcript` — full message history

**Other**
- `GET  /api/health`
- `GET  /api/settings` / `POST /api/settings`
- `POST /api/upload-image`
- `GET  /api/ws` — WebSocket

## WebSocket Message Types

**Server → Client (session)**
`connected`, `session`, `chunk`, `thinking`, `done`, `cancelled`, `reconnecting`, `error`, `pong`

**Server → Client (tasks, broadcast)**
`task:created`, `task:progress`, `task:done`, `task:error`, `task:cancelled`

**Client → Server**
`ping`, `resume`, `chat`, `cancel`

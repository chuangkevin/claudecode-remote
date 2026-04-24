# claudecode-remote — AI Assistant Rules

## Project Overview

Web interface for Claude Code CLI. Lets users access Claude Code from any device (phone, tablet, browser). Supports real-time streaming, image upload, session management, and persistent CLI processes per session.

## Architecture

- **Backend**: Fastify + `@fastify/websocket` on port 9224
- **Frontend**: React + Vite + Tailwind CSS (single `App.tsx`)
- **CLI bridge**: `packages/server/src/claude.ts` — persistent process pool, one CLI process per session

## Key Design Decisions

- `--no-session-persistence` flag: avoids Windows session lock; our sessions are tracked in `sessionMeta` (not `~/.claude/projects/`)
- Persistent CLI process per session: messages written to stdin, resolved on `type: "result"` events; 5-min idle timeout
- History injection: only on first message to a freshly spawned process (`buildContextualMessage`)
- Default system prompt: defined in `claude.ts` as `DEFAULT_SYSTEM_PROMPT`; user overrides replace it entirely

## Development Rules

- Read current code before changing anything
- Prefer smallest correct fix; no refactors beyond the task
- No magic numbers — use named constants
- No silent fallbacks — surface errors to the user

## Completion Checklist

Every code change must:
1. Build clean: `npm run build`
2. Pass E2E: `npx playwright test`
3. Commit and push to `main`

## Commands

```bash
npm install          # install deps
npm run build        # build server + web
node packages/server/dist/index.js  # start server (port 9224)
npx playwright test  # E2E tests (server must be running)
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | 9224 | Server port |
| `HOST` | 0.0.0.0 | Listen address |
| `WORKSPACE_ROOT` | `process.cwd()` | Claude CLI working directory |
| `CLAUDE_DATA_DIR` | `~/.claude` | Claude data directory |

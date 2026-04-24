import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { config } from "./config.js";
import type { StoredMessage } from "./store.js";

export interface ImageInput {
  base64: string;
  mediaType: string;
}

// ── Process pool ──────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

interface ManagedProcess {
  child: ChildProcess;
  fullPrompt: string;         // full --append-system-prompt value (for change detection)
  status: "idle" | "running";
  idleTimer: ReturnType<typeof setTimeout> | null;
  buf: string;                // incomplete stdout line buffer
  stderrBuf: string;
  emittedLength: number;      // dedup partial chunks
  messageCount: number;       // 0 = freshly spawned, inject history on first msg
  onChunk?: (text: string) => void;
  resolve?: () => void;
  reject?: (err: Error) => void;
}

const pool = new Map<string, ManagedProcess>();

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildFullPrompt(userSystemPrompt?: string): string {
  const base = "請始終使用繁體中文回覆。";
  return userSystemPrompt?.trim() ? `${base}\n${userSystemPrompt.trim()}` : base;
}

/**
 * Embed prior conversation turns as a text prefix in the user message.
 * Used only when a process is freshly spawned and the session already has history
 * (e.g. after idle-timeout respawn or server restart).
 */
function buildContextualMessage(userMessage: string, previousMessages: StoredMessage[]): string {
  if (previousMessages.length === 0) return userMessage;
  const history = previousMessages
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `[Prior conversation]\n${history}\n\n[Current message]\n${userMessage}`;
}

function clearIdleTimer(proc: ManagedProcess): void {
  if (proc.idleTimer) { clearTimeout(proc.idleTimer); proc.idleTimer = null; }
}

function startIdleTimer(sessionId: string, proc: ManagedProcess): void {
  clearIdleTimer(proc);
  proc.idleTimer = setTimeout(() => {
    console.log(`[claude] session ${sessionId} idle ${IDLE_TIMEOUT_MS / 60_000}m — killing process`);
    pool.delete(sessionId);
    try { proc.child.kill(); } catch { /* already dead */ }
  }, IDLE_TIMEOUT_MS);
}

function processLine(sessionId: string, proc: ManagedProcess, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: { type: string; [k: string]: unknown };
  try { ev = JSON.parse(trimmed) as typeof ev; } catch { return; }

  if (ev.type === "assistant") {
    const content = (ev.message as { content?: Array<{ type: string; text?: string }> })?.content ?? [];
    let fullText = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") fullText += block.text;
    }
    if (fullText.length > proc.emittedLength) {
      proc.onChunk?.(fullText.slice(proc.emittedLength));
      proc.emittedLength = fullText.length;
    }

  } else if (ev.type === "result") {
    // Response complete — process may keep running (persistent) or exit (one-shot).
    // Either way, resolve the promise now and wait for next stdin message or idle.
    const resolve = proc.resolve;
    proc.status = "idle";
    proc.emittedLength = 0;
    proc.stderrBuf = "";
    proc.onChunk = undefined;
    proc.resolve = undefined;
    proc.reject = undefined;
    startIdleTimer(sessionId, proc);
    resolve?.();

  } else if (ev.type === "error") {
    const msg = typeof ev.message === "string" ? ev.message : "Claude error";
    const reject = proc.reject;
    proc.status = "idle";
    proc.emittedLength = 0;
    proc.stderrBuf = "";
    proc.onChunk = undefined;
    proc.resolve = undefined;
    proc.reject = undefined;
    startIdleTimer(sessionId, proc);
    reject?.(new Error(msg));
  }
  // system/init and other events are ignored
}

function spawnProcess(sessionId: string, fullPrompt: string): ManagedProcess {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  // Use a fresh UUID for the CLI --session-id each spawn so no "session already
  // in use" lock conflicts with previous runs of the same sessionId.
  const args = [
    "--print",
    "--output-format", "stream-json",
    "--verbose",
    "--include-partial-messages",
    "--session-id", randomUUID(),
    "--no-session-persistence",
    "--input-format", "stream-json",
    "--dangerously-skip-permissions",
    "--append-system-prompt", fullPrompt,
  ];

  const child = spawn("claude", args, {
    cwd: config.workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
    env,
  });

  // Suppress EPIPE if we write after the child dies
  child.stdin.on("error", () => {});

  const proc: ManagedProcess = {
    child,
    fullPrompt,
    status: "idle",
    idleTimer: null,
    buf: "",
    stderrBuf: "",
    emittedLength: 0,
    messageCount: 0,
  };

  pool.set(sessionId, proc);

  child.stdout.on("data", (chunk: Buffer) => {
    proc.buf += chunk.toString("utf8");
    const lines = proc.buf.split("\n");
    proc.buf = lines.pop() ?? "";
    for (const line of lines) processLine(sessionId, proc, line);
  });

  child.stderr.on("data", (d: Buffer) => {
    const text = d.toString("utf8");
    proc.stderrBuf += text;
    const line = text.trim();
    if (line) console.error("[claude]", line);
  });

  child.on("error", (err) => {
    console.error("[claude] spawn error:", err);
    pool.delete(sessionId);
    clearIdleTimer(proc);
    if (proc.status === "running") {
      proc.reject?.(err);
      proc.status = "idle";
      proc.resolve = undefined;
      proc.reject = undefined;
    }
  });

  child.on("exit", (code) => {
    // Flush remaining stdout buffer
    if (proc.buf.trim()) processLine(sessionId, proc, proc.buf);

    pool.delete(sessionId);
    clearIdleTimer(proc);

    // If we're still waiting for a result (unexpected exit), reject the promise.
    // If result was already received (resolve called), this is a no-op.
    if (proc.status === "running") {
      const hint = proc.stderrBuf.toLowerCase().includes("context")
        ? " (context too long — try starting a new conversation)"
        : proc.stderrBuf.trim() ? ` — ${proc.stderrBuf.trim().split("\n")[0]}` : "";
      proc.reject?.(new Error(`claude exited with code ${code}${hint}`));
      proc.status = "idle";
      proc.resolve = undefined;
      proc.reject = undefined;
    }
  });

  // Start idle timer immediately — kills if nobody sends a first message
  startIdleTimer(sessionId, proc);

  console.log(`[claude] spawned process for session ${sessionId}`);
  return proc;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Send a message to the persistent CLI process for this session.
 *
 * If no process exists (first call, idle timeout, or crash), a new one is
 * spawned.  If the process is freshly spawned and there are prior messages,
 * history is injected as a text prefix in the first stdin message so the
 * model has full context.
 *
 * Subsequent messages to a living process go directly — no injection needed
 * because the CLI maintains conversation state in its own memory.
 */
export function runClaude(
  sessionId: string,
  userMessage: string,
  previousMessages: StoredMessage[],
  onChunk: (text: string) => void,
  systemPrompt?: string,
  images?: ImageInput[],
): Promise<void> {
  const fullPrompt = buildFullPrompt(systemPrompt);

  let proc = pool.get(sessionId);

  // Respawn if: no process, process has exited, or system prompt changed
  if (!proc || proc.child.exitCode !== null || proc.child.killed || proc.fullPrompt !== fullPrompt) {
    if (proc) {
      clearIdleTimer(proc);
      try { proc.child.kill(); } catch { /* already dead */ }
      pool.delete(sessionId);
    }
    proc = spawnProcess(sessionId, fullPrompt);
  }

  clearIdleTimer(proc);

  return new Promise((resolve, reject) => {
    const p = proc!;
    p.status = "running";
    p.onChunk = onChunk;
    p.resolve = resolve;
    p.reject = reject;
    p.emittedLength = 0;

    // First message to a freshly spawned process: inject history as context
    const isFirst = p.messageCount === 0;
    p.messageCount++;

    const text = isFirst
      ? buildContextualMessage(userMessage, previousMessages)
      : userMessage;

    const content = images && images.length > 0
      ? [
          ...images.map(img => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 },
          })),
          { type: "text", text },
        ]
      : text;

    p.child.stdin!.write(
      JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n",
      "utf8",
    );
  });
}

/** Forcibly kill the process for a session (e.g. when session is deleted). */
export function killSession(sessionId: string): void {
  const proc = pool.get(sessionId);
  if (!proc) return;
  clearIdleTimer(proc);
  pool.delete(sessionId);
  try { proc.child.kill(); } catch { /* already dead */ }
  console.log(`[claude] killed process for session ${sessionId}`);
}

/** Return pool stats for diagnostics. */
export function poolStats(): { sessionId: string; status: string; messageCount: number }[] {
  return Array.from(pool.entries()).map(([id, p]) => ({
    sessionId: id,
    status: p.status,
    messageCount: p.messageCount,
  }));
}

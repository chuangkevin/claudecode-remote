import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import treeKill from "tree-kill";
import { config } from "./config.js";
import type { StoredMessage } from "./store.js";

export interface ImageInput {
  base64: string;
  mediaType: string;
}

// ── Process pool ──────────────────────────────────────────────────────────────

const IDLE_TIMEOUT_MS = process.env.TEST_IDLE_TIMEOUT_MS
  ? Number.parseInt(process.env.TEST_IDLE_TIMEOUT_MS, 10)
  : 5 * 60 * 1000; // 5 minutes (overridable for tests)

interface ManagedProcess {
  child: ChildProcess;
  status: "idle" | "running";
  idleTimer: ReturnType<typeof setTimeout> | null;
  buf: string;                // incomplete stdout line buffer
  stderrBuf: string;
  emittedLength: number;      // dedup partial chunks
  thinkingEmittedLength: number;
  messageCount: number;       // 0 = freshly spawned, inject history on first msg
  promptSent: boolean;        // true after system prompt has been injected once
  authError: boolean;         // 401 / authentication_error detected in stderr or event
  onChunk?: (text: string) => void;
  onThinking?: (text: string) => void;
  resolve?: () => void;
  reject?: (err: Error) => void;
}

const pool = new Map<string, ManagedProcess>();

// ── Helpers ───────────────────────────────────────────────────────────────────

// ── Default system prompt (neutral / shippable) ───────────────────────────────
// Path values are templated as {{WORKSPACE_ROOT}} and substituted at runtime
// against config.workspaceRoot, so no machine-specific paths are baked in.
// User overrides (stored in DB) may also use {{WORKSPACE_ROOT}}.
export const DEFAULT_SYSTEM_PROMPT = `你是派遣指揮官（Dispatch Orchestrator）。你不自己做事，你派遣子任務。

## 你的角色

你不是執行者，你是指揮官。你的 context window 只用來：理解需求、派遣子任務、整合回報。
不要自己讀檔案、跑命令、寫程式碼 — 這些全部交給子任務。

### 行為規則
1. 收到使用者訊息後，判斷需要做什麼
2. 建立子任務（用 DISPATCH 指令）讓子 agent 執行
3. 子任務完成後，整合結果回報給使用者
4. 回應要簡短：說明你派了什麼任務，不要重複貼程式碼

### 什麼時候派遣（幾乎所有事）
- 讀檔案、搜尋程式碼 → 派遣
- 跑命令、查狀態 → 派遣
- 寫/改程式碼、bug 修復 → 派遣
- 任何需要工具的事 → 派遣

### 什麼時候不派遣（極少數例外）
- 純對話、打招呼
- 整合多個子任務的結果
- 使用者已貼出所有內容，不需要查任何東西

**不確定要不要派遣時，派遣。**

## 基本規則
- 始終使用繁體中文回覆

## 派工指令格式

在回應末尾加上派工指令，每個指令一行：

格式（指定 repo）：[DISPATCH:repoPath|任務描述]
格式（預設 workspace）：[DISPATCH:任務描述]

範例：
[DISPATCH:重構 auth.ts 的錯誤處理，加上 retry 邏輯]
[DISPATCH:{{WORKSPACE_ROOT}}\\some-repo|讀取該 repo 的 README 並回報摘要]

預設工作目錄：{{WORKSPACE_ROOT}}

規則：
- DISPATCH 指令放在正文之後（不要夾在說明中間）
- repoPath 用 | 與任務描述分隔；省略 repoPath 就用預設工作目錄
- 每個指令建立一個獨立 Claude agent，完成後結果會自動回報到這個對話
- 不需要等待子任務完成，繼續回應使用者即可
- 可以同時派多個子任務並行執行`;

/** Replace {{WORKSPACE_ROOT}} in the prompt with the configured workspace path. */
export function applyPromptTemplate(prompt: string): string {
  return prompt.replaceAll("{{WORKSPACE_ROOT}}", config.workspaceRoot);
}

function resolveSystemPrompt(userSystemPrompt?: string): string {
  const raw = userSystemPrompt?.trim() ? userSystemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
  return applyPromptTemplate(raw);
}

/** Strip the UI-only [TASK_RESULT:<id>] marker line so the AI sees clean content. */
function stripUiMarkers(content: string): string {
  return content.replace(/^\[TASK_RESULT:[^\]]+\]\r?\n?/, "");
}

function buildMessageText(
  userMessage: string,
  systemPrompt: string,
  previousMessages: StoredMessage[],
  includeSystemPrompt: boolean,
  includeHistory: boolean,
): string {
  const parts: string[] = [];
  if (includeSystemPrompt) parts.push(`[系統指令]\n${systemPrompt}`);
  if (includeHistory && previousMessages.length > 0) {
    const history = previousMessages
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${stripUiMarkers(m.content)}`)
      .join("\n\n");
    parts.push(`[Prior conversation]\n${history}`);
  }
  parts.push(includeSystemPrompt || includeHistory ? `[使用者訊息]\n${userMessage}` : userMessage);
  return parts.join("\n\n");
}

function clearIdleTimer(proc: ManagedProcess): void {
  if (proc.idleTimer) { clearTimeout(proc.idleTimer); proc.idleTimer = null; }
}

function killProcessSafely(proc: ManagedProcess): void {
  const pid = proc.child.pid;
  if (!pid) return;

  treeKill(pid, "SIGKILL", (err) => {
    if (err && !err.message.includes("no such process")) {
      console.error(`[claude] failed to kill process tree ${pid}:`, err.message);
    }
  });
}

function startIdleTimer(sessionId: string, proc: ManagedProcess): void {
  clearIdleTimer(proc);
  proc.idleTimer = setTimeout(() => {
    console.log(`[claude] session ${sessionId} idle ${IDLE_TIMEOUT_MS / 60_000}m — killing process`);
    pool.delete(sessionId);
    killProcessSafely(proc);
  }, IDLE_TIMEOUT_MS);
}

function processLine(sessionId: string, proc: ManagedProcess, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: { type: string; [k: string]: unknown };
  try { ev = JSON.parse(trimmed) as typeof ev; } catch { return; }

  if (ev.type === "assistant") {
    type Block = { type: string; text?: string; thinking?: string };
    const content = (ev.message as { content?: Block[] })?.content ?? [];
    let fullText = "";
    let fullThinking = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") fullText += block.text;
      if (block.type === "thinking" && typeof block.thinking === "string") fullThinking += block.thinking;
    }
    if (fullThinking.length > proc.thinkingEmittedLength) {
      proc.onThinking?.(fullThinking.slice(proc.thinkingEmittedLength));
      proc.thinkingEmittedLength = fullThinking.length;
    }
    if (fullText.length > proc.emittedLength) {
      proc.onChunk?.(fullText.slice(proc.emittedLength));
      proc.emittedLength = fullText.length;
    }

  } else if (ev.type === "result") {
    const resolve = proc.resolve;
    proc.status = "idle";
    proc.emittedLength = 0;
    proc.thinkingEmittedLength = 0;
    proc.stderrBuf = "";
    proc.onChunk = undefined;
    proc.onThinking = undefined;
    proc.resolve = undefined;
    proc.reject = undefined;
    startIdleTimer(sessionId, proc);
    resolve?.();

  } else if (ev.type === "error") {
    const msg = typeof ev.message === "string" ? ev.message : "Claude error";
    if (/401|authentication_error|Please run \/login/i.test(msg)) proc.authError = true;
    const reject = proc.reject;
    const isAuth = proc.authError;
    proc.status = "idle";
    proc.emittedLength = 0;
    proc.thinkingEmittedLength = 0;
    proc.stderrBuf = "";
    proc.authError = false;
    proc.onChunk = undefined;
    proc.onThinking = undefined;
    proc.resolve = undefined;
    proc.reject = undefined;
    if (isAuth) {
      // Auth-broken process must be evicted immediately so the retry in
      // websocket.ts spawns a completely fresh CLI process instead of
      // reusing this one (which would get another 401).
      pool.delete(sessionId);
      clearIdleTimer(proc);
      killProcessSafely(proc);
    } else {
      startIdleTimer(sessionId, proc);
    }
    reject?.(new Error(isAuth ? `AUTH_401: ${msg}` : msg));
  }
  // system/init and other events are ignored
}

function spawnProcess(sessionId: string): ManagedProcess {
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
  ];

  const child = spawn("claude", args, {
    cwd: config.workspaceRoot,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
    env,
  });

  // Handle stdin errors (EPIPE, pipe broken, etc.)
  // These are logged to help diagnose write failures but not propagated
  // because the process exit handler will reject the pending promise.
  child.stdin.on("error", (err) => {
    console.error(`[claude] stdin error for session ${sessionId}:`, err.message);
  });

  const proc: ManagedProcess = {
    child,
    status: "idle",
    idleTimer: null,
    buf: "",
    stderrBuf: "",
    emittedLength: 0,
    thinkingEmittedLength: 0,
    messageCount: 0,
    promptSent: false,
    authError: false,
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
    if (/401|authentication_error|Please run \/login/i.test(text)) proc.authError = true;
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
      let errMsg: string;
      if (proc.authError) {
        errMsg = "AUTH_401: Authentication expired — run `claude setup-token` for persistent headless auth (one-time fix), or `claude login` to refresh OAuth";
      } else {
        const hint = proc.stderrBuf.toLowerCase().includes("context")
          ? " (context too long — try starting a new conversation)"
          : proc.stderrBuf.trim() ? ` — ${proc.stderrBuf.trim().split("\n")[0]}` : "";
        errMsg = `claude exited with code ${code}${hint}`;
      }
      proc.reject?.(new Error(errMsg));
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
  onThinking?: (text: string) => void,
): Promise<void> {
  let proc = pool.get(sessionId);

  // Respawn if: no process, or process has exited
  if (!proc || proc.child.exitCode !== null || proc.child.killed) {
    if (proc) {
      clearIdleTimer(proc);
      killProcessSafely(proc);
      pool.delete(sessionId);
    }
    proc = spawnProcess(sessionId);
  }

  clearIdleTimer(proc);

  return new Promise((resolve, reject) => {
    const p = proc!;
    p.status = "running";
    p.onChunk = onChunk;
    p.onThinking = onThinking;
    p.resolve = resolve;
    p.reject = reject;
    p.emittedLength = 0;
    p.thinkingEmittedLength = 0;

    // Include history only on the very first message of a freshly spawned process.
    // This ensures reconnected sessions still have full context after the CLI
    // process was killed (idle timeout or crash) and respawned.
    const isFirstMessageOfNewProcess = p.messageCount === 0;
    p.messageCount++;

    const includeSystemPrompt = !p.promptSent;
    if (includeSystemPrompt) p.promptSent = true;

    const effectivePrompt = resolveSystemPrompt(systemPrompt);
    const text = buildMessageText(
      userMessage,
      effectivePrompt,
      previousMessages,
      includeSystemPrompt,
      isFirstMessageOfNewProcess,
    );

    const content = images && images.length > 0
      ? [
          ...images.map(img => ({
            type: "image",
            source: { type: "base64", media_type: img.mediaType, data: img.base64 },
          })),
          { type: "text", text },
        ]
      : text;

    // Write to stdin with error handling — if write fails immediately,
    // reject the promise. Async errors (EPIPE after process dies) are
    // handled by the stdin error listener and process exit handler.
    try {
      const payload = JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n";
      const success = p.child.stdin!.write(payload, "utf8", (err) => {
        if (err) {
          console.error(`[claude] stdin write callback error for session ${sessionId}:`, err.message);
          // If the promise is still pending, reject it
          if (p.status === "running" && p.reject) {
            const currentReject = p.reject;
            p.status = "idle";
            p.resolve = undefined;
            p.reject = undefined;
            p.onChunk = undefined;
            p.onThinking = undefined;
            currentReject(new Error(`Failed to write to stdin: ${err.message}`));
          }
        }
      });

      // If write buffer is full (backpressure), log a warning but don't fail
      if (!success) {
        console.warn(`[claude] stdin write backpressure for session ${sessionId} — buffered`);
      }
    } catch (err) {
      // Synchronous write error (rare) — reject immediately
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[claude] stdin write sync error for session ${sessionId}:`, errMsg);
      p.status = "idle";
      p.resolve = undefined;
      p.reject = undefined;
      p.onChunk = undefined;
      p.onThinking = undefined;
      reject(new Error(`Failed to write to stdin: ${errMsg}`));
    }
  });
}

/**
 * Cancel an in-progress Claude run for a session.
 * Kills the process and rejects the in-flight promise with "Cancelled".
 * Returns true if something was cancelled, false if nothing was running.
 */
export function cancelSession(sessionId: string): boolean {
  const proc = pool.get(sessionId);
  if (!proc || proc.status !== "running") return false;

  // Capture reject before clearing, so exit handler doesn't double-fire
  const reject = proc.reject;
  proc.resolve = undefined;
  proc.reject = undefined;
  proc.onChunk = undefined;
  proc.onThinking = undefined;
  proc.status = "idle";

  clearIdleTimer(proc);
  pool.delete(sessionId);
  try { proc.child.kill(); } catch { /* already dead */ }

  reject?.(new Error("Cancelled"));
  console.log(`[claude] cancelled session ${sessionId}`);
  return true;
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

/**
 * Get the CLI process status for a session (if it exists).
 * Returns "idle" if no process exists (e.g., after crash or cleanup).
 */
export function getProcessStatus(sessionId: string): "idle" | "running" {
  const proc = pool.get(sessionId);
  return proc?.status ?? "idle";
}

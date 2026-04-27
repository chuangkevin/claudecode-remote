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

// Per-message hard timeout. If the CLI never emits a result/error event
// within this window, we assume it is stuck and reject so the session can
// recover ("Still processing previous message" lockout fix).
const MESSAGE_TIMEOUT_MS = process.env.TEST_MESSAGE_TIMEOUT_MS
  ? Number.parseInt(process.env.TEST_MESSAGE_TIMEOUT_MS, 10)
  : 10 * 60 * 1000; // 10 minutes

interface ManagedProcess {
  child: ChildProcess;
  status: "idle" | "running";
  idleTimer: ReturnType<typeof setTimeout> | null;
  messageTimer: ReturnType<typeof setTimeout> | null;
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

// ── Default system prompt (Pure Dispatch Orchestrator) ───────────────────────
// Path values are templated as {{WORKSPACE_ROOT}} and substituted at runtime
// against config.workspaceRoot, so no machine-specific paths are baked in.
// User overrides (stored in DB) may also use {{WORKSPACE_ROOT}}.
export const DEFAULT_SYSTEM_PROMPT = `你是派遣指揮官（Pure Dispatch Orchestrator）。你完全不自己做事，你只派遣子任務並整合回報。

## 核心原則：絕對純派遣模式

你的 context window 是稀缺資源，只能用來：
1. 理解使用者需求
2. 拆解成子任務並派遣（DISPATCH 指令）
3. 接收子任務回報並整合給使用者

**你絕對不能自己做的事**（一律派遣給子 agent）：
- ❌ 自己讀任何檔案（即使只是看一眼）
- ❌ 自己跑任何命令（git status、ls、cat、curl 全部禁止）
- ❌ 自己寫或改任何程式碼
- ❌ 自己搜尋程式碼（grep、glob）
- ❌ 自己查狀態、看 log、確認部署
- ❌ 自己做任何需要工具呼叫的事

**你唯一可以自己做的事**：
- ✅ 純文字對話（打招呼、確認需求、解釋計畫）
- ✅ 把已收到的子任務回報整合成摘要回覆使用者
- ✅ 規劃要派遣哪些子任務

### 什麼時候派遣（幾乎所有事）
- 讀檔案、搜尋程式碼 → 派遣
- 跑命令、查狀態 → 派遣
- 寫/改程式碼、bug 修復 → 派遣
- 任何需要工具的事 → 派遣

**鐵律**：只要使用者的訊息需要任何「動作」（不只是聊天），第一反應就是派遣，不要自己動手。
不確定要不要派遣？→ 派遣。

## 派遣範例

使用者：「幫我看 server.ts 在做什麼」
你：好，派子任務去讀。
[DISPATCH:讀 packages/server/src/server.ts，回報它的功能和對外介面]

使用者：「修 login 的 bug」
你：派子任務去定位並修復。
[DISPATCH:在 packages/web/src/ 找 login 相關程式碼，定位 bug 並修復，commit + push 完成後回報 commit hash]

使用者：「服務還活著嗎？」
你：派子任務檢查。
[DISPATCH:curl http://localhost:9224/api/health，回報結果]

## 派工指令格式

在回應末尾加上派工指令，每個指令獨立一行：

格式（指定 repo）：[DISPATCH:repoPath|任務描述]
格式（預設 workspace）：[DISPATCH:任務描述]

範例：
[DISPATCH:{{WORKSPACE_ROOT}}\\other-repo|重構 auth.ts 的錯誤處理]
[DISPATCH:讀取 CLAUDE.md 並回報摘要]

預設工作目錄：{{WORKSPACE_ROOT}}

規則：
- DISPATCH 指令放在回應的最後段落，每個一行
- repoPath 用 | 與任務描述分隔；省略則用預設工作目錄（{{WORKSPACE_ROOT}}）
- 子任務描述要完整、可獨立執行（子 agent 看不到這個對話的歷史）
- 子任務完成後結果會自動回報到這個對話，你再整合給使用者
- 多個獨立子任務可同時派遣並行執行
- 不要等待，派完繼續回應使用者

## 子任務必須交代的事項

派遣時直接在任務描述裡寫清楚（你自己不執行，這些是給子 agent 的指示）：
- 涉及程式碼改動 → 「完成後 build → commit → push，回報 commit hash」
- 涉及部署 → 「確認 health check 通過，回報結果」
- 涉及修 bug → 「找根本原因，不要只貼 OK；驗證後回報」
- 涉及系統設定（Caddy、nginx、Docker）→ 「先讀 homelab-docs 確認架構再改，最小變更，改完驗證」
- 不確定的細節 → 「不准猜，先查 homelab-docs / 既有設定」

## 基本規則
- 始終使用繁體中文回覆
- 回應要簡短：說「我派了 X 任務去做 Y」就夠，不要解釋程式碼細節
- 子任務還沒回報完之前，不要假裝知道結果
- 沒有實際驗證證據前，不准說「完成了」

## 程式碼分析與審計規則
- 每個發現必須附程式碼行號或 grep 結果作為證據
- 數字必須用工具驗證（grep -c、wc -l 等），不准估算
- 明確區分「確認」（有證據）和「推測」（需進一步驗證）
- 不准只看變數名稱就猜行為，必須追蹤完整邏輯流
- 報告裡的每一項都要標註：✅ 已驗證 / ⚠️ 待驗證
- 如果沒讀到相關程式碼就不要下結論

## Homelab 準則（必讀）
- 所有基礎設施操作前，必須先讀 homelab-docs 了解架構
- homelab-docs 位於 {{WORKSPACE_ROOT}}\\homelab-docs
- 包含：domain mapping、部署架構、服務 port 對照、WiFi 穩定性設定、cloudflared 設定
- 不知道某台機器的架構就不准動它
- 每個專案都有 CLAUDE.md，操作前必讀

## 絕對禁止
- ❌ 自己呼叫工具（Read/Bash/Edit/Grep 等）— 一切交給子任務
- ❌ 用 ✅ emoji 假裝完成
- ❌ 在主對話裡貼大段程式碼或檔案內容（會吃光 context）
- ❌ 動使用者帳號資料（除非明確要求）`;

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

function clearMessageTimer(proc: ManagedProcess): void {
  if (proc.messageTimer) { clearTimeout(proc.messageTimer); proc.messageTimer = null; }
}

// Force-clear all per-run state on a managed process. Called from result/error
// paths and from the message-timeout fallback so callers can't be left dangling.
function resetRunState(proc: ManagedProcess): void {
  proc.status = "idle";
  proc.emittedLength = 0;
  proc.thinkingEmittedLength = 0;
  proc.stderrBuf = "";
  proc.onChunk = undefined;
  proc.onThinking = undefined;
  proc.resolve = undefined;
  proc.reject = undefined;
  clearMessageTimer(proc);
}

function startMessageTimer(sessionId: string, proc: ManagedProcess): void {
  clearMessageTimer(proc);
  proc.messageTimer = setTimeout(() => {
    if (proc.status !== "running") return;
    console.error(`[claude] session ${sessionId} message timeout after ${MESSAGE_TIMEOUT_MS / 60_000}m — killing process`);
    const reject = proc.reject;
    resetRunState(proc);
    pool.delete(sessionId);
    clearIdleTimer(proc);
    killProcessSafely(proc);
    reject?.(new Error(`Message timeout: no response from Claude CLI after ${MESSAGE_TIMEOUT_MS / 60_000} minutes`));
  }, MESSAGE_TIMEOUT_MS);
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
    resetRunState(proc);
    startIdleTimer(sessionId, proc);
    resolve?.();

  } else if (ev.type === "error") {
    const msg = typeof ev.message === "string" ? ev.message : "Claude error";
    if (/401|authentication_error|Please run \/login/i.test(msg)) proc.authError = true;
    const reject = proc.reject;
    const isAuth = proc.authError;
    resetRunState(proc);
    proc.authError = false;
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
    messageTimer: null,
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
    clearMessageTimer(proc);
    if (proc.status === "running") {
      const reject = proc.reject;
      resetRunState(proc);
      reject?.(err);
    }
  });

  child.on("exit", (code) => {
    // Flush remaining stdout buffer
    if (proc.buf.trim()) processLine(sessionId, proc, proc.buf);

    pool.delete(sessionId);
    clearIdleTimer(proc);
    clearMessageTimer(proc);

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
      const reject = proc.reject;
      resetRunState(proc);
      reject?.(new Error(errMsg));
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
  clearMessageTimer(proc);

  return new Promise((resolve, reject) => {
    const p = proc!;
    p.status = "running";
    p.onChunk = onChunk;
    p.onThinking = onThinking;
    p.resolve = resolve;
    p.reject = reject;
    p.emittedLength = 0;
    p.thinkingEmittedLength = 0;
    startMessageTimer(sessionId, p);

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
            resetRunState(p);
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
      resetRunState(p);
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
  resetRunState(proc);

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
  clearMessageTimer(proc);
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

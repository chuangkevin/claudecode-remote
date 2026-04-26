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

const DEFAULT_SYSTEM_PROMPT = `你是 Kevin 的 AI 開發助手。

## 開發準則
- 請先讀取 D:\\GitClone\\_HomeProject\\homelab-docs，這是所有專案的開發準則，務必遵守
- 請始終使用繁體中文回覆

## 工作流程
每次完成任務後必須執行：
1. 更新文件（CLAUDE.md、AI-HANDOFF.md）
2. 更新記憶（.auto-memory/）
3. 更新 spec（OpenSpec）
4. Commit + Push
5. 確認 branch 收斂（worktree 合回、無散落分支）

## Bug 回報流程
當 Kevin 說「我要回報 bug」時：
1. 等 Kevin 完整描述完畢，不要中途開始修
2. 用 Superpowers 框架分析問題
3. 建立 OpenSpec 紀錄
4. 開始修復
5. 修完後用 Chrome/Playwright 做 Live E2E 測試
6. 截圖回報測試結果

## 測試規則
- 「測試」= 到 Live 網站做 E2E 測試（不是只看程式碼）
- 每個測試步驟要有截圖
- 測試通過才回報完成
- 不要跳過測試說「完成了」

## 部署規則
- 改完 push 後要確認 CI/CD 部署成功
- 確認部署版本號跟預期一致
- 部署完要確認 health check

## 程式碼品質
- 不准直接重建資料庫，schema 變更用 additive migration
- Gemini model 用 gemini-2.5-flash（文字）、gemini-3-pro-image-preview（圖片）
- 不要升級現有 dependencies 版本
- 不要 hardcode，所有解析用 AI、CI/CD 用 secrets
- 錯誤要 surface 給使用者，不要靜默 fallback

## 絕對禁止
- 不准用 ✅ emoji 假裝完成，除非有實際證據（截圖、log、curl 回應）
- 不准說「完成了」但沒有實際驗證
- 不准跳過讀取 homelab-docs 準則
- 不准自行決定任務完成，必須有可驗證的產出
- 不准說「完成了」但功能沒在 production 上生效
- 不准只在程式碼層面確認，必須實際操作驗證
- 不准留散落的 worktree 或 branch
- 不准動使用者的帳號資料（除非明確要求）

## 第一步
每次新對話開始，必須先讀取 D:\\GitClone\\_HomeProject\\homelab-docs 的準則，然後遵守。不讀不做事。

## 回報格式
完成任務時必須附上證據：
- 程式碼改動：git diff 或 commit hash
- 部署：health check 結果
- 測試：實際輸出或截圖
沒有證據 = 沒完成

## 回應風格
- 簡短精確，不需要摘要或過多說明
- 下一步明確時直接執行，不需再次確認
- 找根本原因，不只修表面症狀
- Kevin 說「快點」就是真的很急
- 發現問題就要修正，不要只回報不動手
- 進度要主動回報

## 子任務自動派工
當你判斷有部分工作可以交給獨立 agent 並行執行（例如跨 repo 修改、大型重構、長跑任務），
在回應末尾加上派工指令，每個指令一行：

格式（指定 repo）：[DISPATCH:repoPath|任務描述]
格式（預設 workspace）：[DISPATCH:任務描述]

範例：
[DISPATCH:D:\\GitClone\\_HomeProject\\other-repo|重構 auth.ts 的錯誤處理，加上 retry 邏輯]
[DISPATCH:更新 README.md 的 API 文件章節]

規則：
- DISPATCH 指令放在正文之後（不要夾在說明中間）
- repoPath 用 | 與任務描述分隔；如果省略 repoPath 就用預設工作目錄
- 每個指令建立一個獨立 Claude agent，完成後結果會自動回報到這個對話
- 不需要等待子任務完成，繼續回應使用者即可`;

function resolveSystemPrompt(userSystemPrompt?: string): string {
  return userSystemPrompt?.trim() ? userSystemPrompt.trim() : DEFAULT_SYSTEM_PROMPT;
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
      .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
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

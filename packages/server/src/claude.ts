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
  status: "idle" | "running";
  idleTimer: ReturnType<typeof setTimeout> | null;
  buf: string;                // incomplete stdout line buffer
  stderrBuf: string;
  emittedLength: number;      // dedup partial chunks
  messageCount: number;       // 0 = freshly spawned, inject history on first msg
  promptSent: boolean;        // true after system prompt has been injected once
  onChunk?: (text: string) => void;
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

## 禁止事項
- 不准說「完成了」但功能沒在 production 上生效
- 不准只在程式碼層面確認，必須實際操作驗證
- 不准留散落的 worktree 或 branch
- 不准動使用者的帳號資料（除非明確要求）

## 回應風格
- 簡短精確，不需要摘要或過多說明
- 下一步明確時直接執行，不需再次確認
- 找根本原因，不只修表面症狀
- Kevin 說「快點」就是真的很急
- 發現問題就要修正，不要只回報不動手
- 進度要主動回報`;

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

  // Suppress EPIPE if we write after the child dies
  child.stdin.on("error", () => {});

  const proc: ManagedProcess = {
    child,
    status: "idle",
    idleTimer: null,
    buf: "",
    stderrBuf: "",
    emittedLength: 0,
    messageCount: 0,
    promptSent: false,
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
  let proc = pool.get(sessionId);

  // Respawn if: no process, or process has exited
  if (!proc || proc.child.exitCode !== null || proc.child.killed) {
    if (proc) {
      clearIdleTimer(proc);
      try { proc.child.kill(); } catch { /* already dead */ }
      pool.delete(sessionId);
    }
    proc = spawnProcess(sessionId);
  }

  clearIdleTimer(proc);

  return new Promise((resolve, reject) => {
    const p = proc!;
    p.status = "running";
    p.onChunk = onChunk;
    p.resolve = resolve;
    p.reject = reject;
    p.emittedLength = 0;

    const isFirst = p.messageCount === 0;
    p.messageCount++;

    const includeSystemPrompt = !p.promptSent;
    if (includeSystemPrompt) p.promptSent = true;

    const effectivePrompt = resolveSystemPrompt(systemPrompt);
    const text = buildMessageText(userMessage, effectivePrompt, previousMessages, includeSystemPrompt, isFirst);

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

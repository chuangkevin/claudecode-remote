import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config.js";
import { setupWebSocketHandler } from "./websocket.js";
import { getSettings, saveSettings } from "./settings.js";
import { initDb, migrateFromJson, dbLoadAllSessions, dbLoadMessages, dbUpsertSession, dbLoadTaskMessages, dbInsertMessage } from "./db.js";
import { loadSession, getSession, broadcast } from "./store.js";
import type { StoredMessage } from "./store.js";
import { storeImage } from "./image-store.js";
import { createTask, cancelTask, deleteTask, listTasks, getTask, loadTasksFromDb, taskEvents } from "./task-manager.js";
import { runClaude } from "./claude.js";
import { addPendingDispatch, consumePendingDispatch } from "./pending-dispatch.js";

// ── DB init + startup load ────────────────────────────────────────────────────

initDb();
migrateFromJson(join(config.claudeDataDir, "claudecode-remote.json"));
loadTasksFromDb();

// When a sub-task finishes with a parentSessionId, inject the result into
// the parent session as a new assistant message and broadcast to subscribers.
//
// Format:
//   line 1: [TASK_RESULT:<taskId>]               ← UI marker for compact card
//   line 2: （子任務「<prompt>」（在 <repo>）{結束狀態}）  ← AI-readable frame
//   blank line
//   rest:   <sub-agent output OR error message>  ← AI context for next turn
//
// Both done and error/cancelled inject — otherwise the main agent has no
// visibility into failures and can't react on the next user turn.
function injectTaskOutcome(
  taskId: string,
  parentSessionId: string,
  outcome: "done" | "error" | "cancelled",
): void {
  const session = getSession(parentSessionId);
  if (!session) return;
  const task = getTask(taskId);

  const promptShort = task?.prompt
    ? (task.prompt.length > 100 ? task.prompt.slice(0, 100).trim() + "…" : task.prompt.trim())
    : "";
  const repoLabel = task?.repoPath
    ? (task.repoPath.split(/[\\/]/).filter(Boolean).pop() ?? "workspace")
    : "workspace";

  let frame: string;
  let body: string;
  if (outcome === "done") {
    frame = `（子任務「${promptShort}」（在 ${repoLabel}）已完成，以下為其輸出）`;
    const lastMsg = task?.messages.slice().reverse().find((m: { role: string }) => m.role === "assistant");
    body = lastMsg?.content ?? "（無輸出）";
  } else if (outcome === "cancelled") {
    frame = `（子任務「${promptShort}」（在 ${repoLabel}）已被取消）`;
    body = "使用者或系統取消了這個子任務。請告訴使用者，或詢問是否需要重新派遣。";
  } else {
    frame = `（子任務「${promptShort}」（在 ${repoLabel}）失敗，請依失敗原因處理：例如確認路徑是否正確、是否要重新派遣、或回報使用者）`;
    const lastMsg = task?.messages.slice().reverse().find((m: { role: string }) => m.role === "assistant");
    const raw = lastMsg?.content ?? "";
    body = raw.startsWith("Error: ") ? `失敗原因：${raw.slice(7)}` : (raw || "（無錯誤訊息）");
  }

  const content = `[TASK_RESULT:${taskId}]\n${frame}\n\n${body}`;
  const msg = { role: "assistant" as const, content, timestamp: Date.now() };
  session.messages.push(msg);
  broadcast(session, { type: "inject", message: msg });
  try { dbInsertMessage(parentSessionId, "assistant", content); } catch { /* best-effort */ }
  console.log(`[dispatch] injected ${outcome} into session ${parentSessionId.slice(0, 8)}`);
}

// ── Orchestrator auto-continuation ────────────────────────────────────────────
//
// addPendingDispatch is called by websocket.ts when [DISPATCH:...] tags are
// parsed (and below, when auto-continue itself dispatches). consumePendingDispatch
// is called when each sub-task finishes. When the pending set drains to
// empty AND the session is idle, autoContinueOrchestrator fires one more
// run of the main agent with a synthetic prompt to integrate the results.

const AUTO_CONTINUE_PROMPT =
  "所有先前派遣的子任務都已結束。請依據上方各 [TASK_RESULT:...] 標記後的內容，整合結果並向使用者回應原本的問題。" +
  "若有失敗的子任務，請告訴使用者失敗原因，並建議下一步該怎麼處理（例如：是否重新派遣、是否需要使用者補資訊）。" +
  "若所有子任務都成功，整合產出回答，不要重複貼出每個子任務的原始輸出。";

async function autoContinueOrchestrator(sessionId: string): Promise<void> {
  const session = getSession(sessionId);
  if (!session) return;
  // Atomic claim: another task finishing concurrently must not also fire a run.
  if (session.status !== "idle") return;
  session.status = "running";
  session.streaming = "";

  let systemPrompt = "";
  try { ({ systemPrompt } = await getSettings()); } catch { /* default */ }

  try {
    await runClaude(
      session.id, AUTO_CONTINUE_PROMPT, session.messages,
      (text) => { session.streaming += text; broadcast(session, { type: "chunk", text }); },
      systemPrompt,
      undefined,
      (text) => { broadcast(session, { type: "thinking", text }); },
    );

    session.lastRunFinishedAt = Date.now();
    session.status = "idle";
    const rawContent = session.streaming;

    // Same DISPATCH parsing as the main chat handler — chained orchestration
    // is allowed (auto-continue can itself dispatch more tasks).
    const DISPATCH_RE = /\[DISPATCH:([^\]]+)\]/g;
    let m: RegExpExecArray | null;
    while ((m = DISPATCH_RE.exec(rawContent)) !== null) {
      const inner = m[1];
      const pipeIdx = inner.indexOf("|");
      const repoPath = pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() || undefined : undefined;
      const prompt   = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : inner.trim();
      if (prompt) {
        const created = createTask({ repoPath, prompt, parentSessionId: session.id });
        if (!("error" in created)) addPendingDispatch(session.id, created.id);
        console.log(`[auto-continue] dispatched: "${prompt.slice(0, 60)}" repo=${repoPath ?? "default"}`);
      }
    }

    const content = rawContent.replace(/\n?\[DISPATCH:[^\]]+\]/g, "").trimEnd();
    session.messages.push({ role: "assistant", content, timestamp: Date.now() });
    session.streaming = "";
    broadcast(session, { type: "done" });
    try {
      dbInsertMessage(session.id, "assistant", content);
      dbUpsertSession(session.id, { updatedAt: session.lastRunFinishedAt });
    } catch (e) { console.error("[auto-continue] DB write error:", e); }
  } catch (err) {
    session.lastRunFinishedAt = Date.now();
    session.streaming = "";
    const errMsg = err instanceof Error ? err.message : String(err);
    if (errMsg === "Cancelled") {
      session.status = "idle";
      broadcast(session, { type: "cancelled" });
      return;
    }
    session.messages.push({ role: "assistant", content: `Error: ${errMsg}`, timestamp: Date.now() });
    session.status = "error";
    broadcast(session, { type: "error", message: errMsg });
    try { dbInsertMessage(session.id, "assistant", `Error: ${errMsg}`); } catch { /* ignore */ }
  }
}

function onTaskFinished(
  taskId: string,
  parentSessionId: string,
  outcome: "done" | "error" | "cancelled",
): void {
  injectTaskOutcome(taskId, parentSessionId, outcome);
  const wasLast = consumePendingDispatch(parentSessionId, taskId);
  if (wasLast) {
    // Defer one tick so the inject broadcast / DB write completes before the
    // next CLI spawn starts reading session.messages.
    setImmediate(() => { void autoContinueOrchestrator(parentSessionId); });
  }
}

taskEvents.on("task:done", (ev: { taskId: string; parentSessionId?: string }) => {
  if (ev.parentSessionId) onTaskFinished(ev.taskId, ev.parentSessionId, "done");
});
taskEvents.on("task:error", (ev: { taskId: string; parentSessionId?: string }) => {
  if (ev.parentSessionId) onTaskFinished(ev.taskId, ev.parentSessionId, "error");
});
taskEvents.on("task:cancelled", (ev: { taskId: string; parentSessionId?: string }) => {
  if (ev.parentSessionId) onTaskFinished(ev.taskId, ev.parentSessionId, "cancelled");
});

// Pre-load all persisted sessions into the in-memory store so they are
// immediately available when clients resume or send chat messages.
for (const s of dbLoadAllSessions()) {
  const msgs: StoredMessage[] = dbLoadMessages(s.id).map(m => ({
    role: m.role as "user" | "assistant",
    content: m.content,
    timestamp: m.created_at,
    ...(m.images_json ? { images: JSON.parse(m.images_json) as string[] } : {}),
  }));
  if (msgs.length > 0) loadSession(s.id, msgs);
}

// ── Fastify ───────────────────────────────────────────────────────────────────

const server = Fastify({ logger: false });

await server.register(fastifyWebsocket);
await server.register(setupWebSocketHandler);

await server.register(fastifyStatic, {
  root: config.webRoot,
  prefix: "/",
});

// ── REST API ──────────────────────────────────────────────────────────────────

server.get("/api/health", async () => ({ status: "ok", version: "0.1.0" }));

server.get("/api/settings", async () => getSettings());

server.post<{ Body: { systemPrompt?: string } }>("/api/settings", async (req, reply) => {
  const { systemPrompt = "" } = req.body ?? {};
  await saveSettings({ systemPrompt });
  return reply.code(200).send({ ok: true });
});

server.post<{ Body: { base64: string; mediaType: string; thumbnail: string } }>(
  "/api/upload-image",
  { bodyLimit: 25 * 1024 * 1024 },
  async (req, reply) => {
    const { base64, mediaType, thumbnail } = req.body ?? {};
    if (!base64 || !mediaType || !thumbnail) return reply.code(400).send({ error: "Missing fields" });
    const id = storeImage(base64, mediaType, thumbnail);
    return { id };
  },
);

// Sessions — source of truth is the DB, not the in-memory store
server.get("/api/sessions", async () =>
  dbLoadAllSessions().map(s => ({
    id: s.id,
    preview: s.preview ?? s.id,
    updatedAt: s.updated_at,
    name: s.name ?? undefined,
    pinned: s.pinned === 1,
  }))
);

server.patch<{ Params: { id: string }; Body: { name: string } }>(
  "/api/sessions/:id/rename",
  async (req) => {
    const { id } = req.params;
    const name = (req.body?.name ?? "").trim();
    dbUpsertSession(id, { name: name || null });
    return { ok: true };
  },
);

server.patch<{ Params: { id: string }; Body: { pinned: boolean } }>(
  "/api/sessions/:id/pin",
  async (req) => {
    const { id } = req.params;
    dbUpsertSession(id, { pinned: Boolean(req.body?.pinned) });
    return { ok: true };
  },
);

// ── Tasks API ─────────────────────────────────────────────────────────────────

server.post<{ Body: { repoPath?: string; prompt?: string; parentSessionId?: string } }>(
  "/api/tasks",
  async (req, reply) => {
    const { repoPath = "", prompt = "", parentSessionId } = req.body ?? {};
    if (!prompt.trim()) return reply.code(400).send({ error: "prompt required" });
    const result = createTask({ repoPath: repoPath.trim(), prompt: prompt.trim(), parentSessionId });
    if ("error" in result) return reply.code(429).send({ error: result.error });
    return { ok: true, task: result };
  },
);

server.get("/api/tasks", async () => listTasks());

server.delete<{ Params: { id: string } }>(
  "/api/tasks/:id",
  async (req, reply) => {
    const { id } = req.params;
    if (cancelTask(id) || deleteTask(id)) return { ok: true };
    return reply.code(404).send({ error: "not found" });
  },
);

server.get<{ Params: { id: string } }>(
  "/api/tasks/:id/transcript",
  async (req, reply) => {
    const { id } = req.params;
    const task = getTask(id);
    if (task) return { messages: task.messages, streaming: task.streaming, status: task.status };
    const rows = dbLoadTaskMessages(id);
    if (rows.length === 0) return reply.code(404).send({ error: "not found" });
    return {
      messages: rows.map(m => ({ role: m.role, content: m.content, timestamp: m.created_at })),
      streaming: "",
      status: "done",
    };
  },
);

// ── Start ─────────────────────────────────────────────────────────────────────

try {
  await server.listen({ port: config.port, host: config.host });
  console.log(`🚀 claudecode-remote server listening on ${config.host}:${config.port}`);
  console.log(`📁 Workspace root: ${config.workspaceRoot}`);
  console.log(`📂 Claude data dir: ${config.claudeDataDir}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

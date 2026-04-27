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

// ── DB init + startup load ────────────────────────────────────────────────────

initDb();
migrateFromJson(join(config.claudeDataDir, "claudecode-remote.json"));
loadTasksFromDb();

// When a sub-task finishes with a parentSessionId, inject the result into
// the parent session as a new assistant message and broadcast to subscribers.
// Format: a [TASK_RESULT:<taskId>] header on the first line so the UI can
// render a compact card that links back to the 任務 tab. The body still
// contains the full result so subsequent AI turns have it in context.
taskEvents.on("task:done", (ev: { taskId: string; parentSessionId?: string }) => {
  if (!ev.parentSessionId) return;
  const session = getSession(ev.parentSessionId);
  if (!session) return;
  const task = getTask(ev.taskId);
  const lastMsg = task?.messages.slice().reverse().find((m: { role: string }) => m.role === "assistant");
  const summary = lastMsg?.content ?? "（無輸出）";
  const content = `[TASK_RESULT:${ev.taskId}]\n${summary}`;
  const msg = { role: "assistant" as const, content, timestamp: Date.now() };
  session.messages.push(msg);
  broadcast(session, { type: "inject", message: msg });
  try { dbInsertMessage(ev.parentSessionId, "assistant", content); } catch { /* best-effort */ }
  console.log(`[dispatch] injected result into session ${ev.parentSessionId.slice(0, 8)}`);
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

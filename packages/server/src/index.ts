import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { join } from "node:path";
import { config } from "./config.js";
import { setupWebSocketHandler } from "./websocket.js";
import { getSettings, saveSettings } from "./settings.js";
import { initDb, migrateFromJson, dbLoadAllSessions, dbLoadMessages, dbUpsertSession } from "./db.js";
import { loadSession } from "./store.js";
import type { StoredMessage } from "./store.js";
import { storeImage } from "./image-store.js";

// ── DB init + startup load ────────────────────────────────────────────────────

initDb();
migrateFromJson(join(config.claudeDataDir, "claudecode-remote.json"));

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
server.register(setupWebSocketHandler);

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

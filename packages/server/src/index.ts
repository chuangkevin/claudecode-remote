import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { setupWebSocketHandler } from "./websocket.js";
import { getSettings, saveSettings, getAllSessionMeta, setSessionMeta } from "./settings.js";
// listDiskSessions intentionally not used: we use --no-session-persistence so our sessions
// never appear in ~/.claude/projects/ JSONL files. Only show sessions we own via sessionMeta.
import { listSessions } from "./store.js";
import { storeImage } from "./image-store.js";

const server = Fastify({
  logger: false,
});

// WebSocket 支援
await server.register(fastifyWebsocket);

// WebSocket 路由
server.register(setupWebSocketHandler);

// 靜態檔案服務（web UI）
await server.register(fastifyStatic, {
  root: config.webRoot,
  prefix: "/",
});

// Health check
server.get("/api/health", async () => {
  return { status: "ok", version: "0.1.0" };
});

// Settings
server.get("/api/settings", async () => {
  return getSettings();
});

server.post<{ Body: { systemPrompt?: string } }>("/api/settings", async (req, reply) => {
  const { systemPrompt = "" } = req.body ?? {};
  await saveSettings({ systemPrompt });
  return reply.code(200).send({ ok: true });
});

// Image upload: stores image in memory, returns ID for use in chat messages
// bodyLimit: 25MB — 2048px JPEG in base64 can be ~3-4MB; phone photos up to ~12MB
server.post<{ Body: { base64: string; mediaType: string; thumbnail: string } }>(
  "/api/upload-image",
  { bodyLimit: 25 * 1024 * 1024 },
  async (req, reply) => {
    const { base64, mediaType, thumbnail } = req.body ?? {};
    if (!base64 || !mediaType || !thumbnail) {
      return reply.code(400).send({ error: "Missing fields" });
    }
    const id = storeImage(base64, mediaType, thumbnail);
    return { id };
  }
);

// Sessions list: only sessions created by claudecode-remote.
// - Live sessions come from the in-memory store.
// - Sessions persisted across restarts come from sessionMeta (source: 'claudecode-remote').
// We intentionally skip ~/.claude/projects/ JSONL scanning to avoid mixing in
// sessions from Dispatch or direct Claude CLI usage.
server.get("/api/sessions", async () => {
  const allMeta = await getAllSessionMeta();

  // Build enriched live sessions from memory
  const liveMap = new Map(listSessions().filter(s => s.messages.length > 0).map(s => [s.id, s]));
  const liveSessions = Array.from(liveMap.values()).map(s => {
    const meta = allMeta[s.id] ?? {};
    const firstUser = s.messages.find(m => m.role === "user");
    return {
      id: s.id,
      preview: firstUser?.content.replace(/\s+/g, " ").trim().slice(0, 80) ?? s.id,
      updatedAt: s.lastRunFinishedAt || Date.now(),
      name: meta.name,
      pinned: meta.pinned ?? false,
    };
  });

  // Sessions that existed before this server process (survived via meta) but are no longer live
  const metaOnlySessions = Object.entries(allMeta)
    .filter(([id, m]) => m.source === "claudecode-remote" && !liveMap.has(id))
    .map(([id, m]) => ({
      id,
      preview: m.preview ?? id,
      updatedAt: m.updatedAt ?? 0,
      name: m.name,
      pinned: m.pinned ?? false,
    }));

  const all = [...liveSessions, ...metaOnlySessions];
  return all.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (!a.pinned && b.pinned) return 1;
    return b.updatedAt - a.updatedAt;
  });
});

// Rename a session
server.patch<{ Params: { id: string }; Body: { name: string } }>(
  "/api/sessions/:id/rename",
  async (req) => {
    const { id } = req.params;
    const name = (req.body?.name ?? "").trim();
    await setSessionMeta(id, { name: name || undefined });
    return { ok: true };
  }
);

// Pin / unpin a session
server.patch<{ Params: { id: string }; Body: { pinned: boolean } }>(
  "/api/sessions/:id/pin",
  async (req) => {
    const { id } = req.params;
    await setSessionMeta(id, { pinned: Boolean(req.body?.pinned) });
    return { ok: true };
  }
);

// 啟動 server
try {
  await server.listen({
    port: config.port,
    host: config.host,
  });
  console.log(`🚀 claudecode-remote server listening on ${config.host}:${config.port}`);
  console.log(`📁 Workspace root: ${config.workspaceRoot}`);
  console.log(`📂 Claude data dir: ${config.claudeDataDir}`);
} catch (err) {
  server.log.error(err);
  process.exit(1);
}

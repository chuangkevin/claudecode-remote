import Fastify from "fastify";
import fastifyWebsocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import { config } from "./config.js";
import { setupWebSocketHandler } from "./websocket.js";
import { getSettings, saveSettings } from "./settings.js";
import { listDiskSessions } from "./session.js";
import { listSessions } from "./store.js";

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

// Sessions list: in-memory (active) sessions merged with disk sessions
server.get("/api/sessions", async () => {
  const diskSessions = await listDiskSessions();
  const diskIds = new Set(diskSessions.map(s => s.id));

  const memorySessions = listSessions()
    .filter(s => !diskIds.has(s.id) && s.messages.length > 0)
    .map(s => ({
      id: s.id,
      preview: (s.messages.find(m => m.role === "user")?.content ?? s.id).replace(/\s+/g, " ").trim().slice(0, 80),
      updatedAt: s.lastRunFinishedAt || Date.now(),
    }));

  return [...memorySessions, ...diskSessions];
});

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

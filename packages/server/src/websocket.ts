import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { runClaude } from "./claude.js";
import { getImage } from "./image-store.js";
import { setSessionMeta } from "./settings.js";
import { getSettings } from "./settings.js";
import { loadMessagesFromDisk } from "./session.js";
import {
  newSession,
  getSession,
  loadSession,
  broadcast,
  type SessionState,
  type SessionEvent,
} from "./store.js";

type ClientMsg =
  | { type: "ping" }
  | { type: "resume"; sessionId?: string | null }
  | { type: "chat"; message: string; sessionId?: string | null; imageIds?: string[] };

function send(ws: WebSocket, obj: unknown): void {
  try { ws.send(JSON.stringify(obj)); } catch { /* ws closed */ }
}

export async function setupWebSocketHandler(server: FastifyInstance) {
  server.get("/api/ws", { websocket: true }, (connection: WebSocket) => {
    let session: SessionState = newSession();
    let unsubscribe: (() => void) | null = null;

    function subscribeTo(s: SessionState): void {
      if (unsubscribe) unsubscribe();
      session = s;
      const handler = (ev: SessionEvent) => {
        if (ev.type === "chunk") {
          send(connection, { type: "chunk", text: ev.text });
        } else if (ev.type === "done") {
          send(connection, { type: "done" });
        } else {
          send(connection, { type: "error", message: (ev as { message: string }).message });
        }
      };
      session.subscribers.add(handler);
      unsubscribe = () => session.subscribers.delete(handler);
    }

    function sendSessionSnapshot(): void {
      send(connection, {
        type: "session",
        sessionId: session.id,
        messages: session.messages,
        streaming: session.streaming,
        status: session.status,
      });
    }

    send(connection, { type: "connected" });

    // Generation counter: incremented each time a resume arrives.
    // If a newer resume arrives while a disk-load is in flight, the old one
    // is abandoned so it cannot overwrite the client's newer session choice.
    let resumeGen = 0;

    connection.on("message", async (raw: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch { return; }

      switch (msg.type) {
        case "ping":
          send(connection, { type: "pong" });
          break;

        case "resume": {
          const gen = ++resumeGen;
          let target: SessionState;
          if (msg.sessionId) {
            // Resume specific session — load from store or disk
            let found = getSession(msg.sessionId);
            if (!found) {
              const messages = await loadMessagesFromDisk(msg.sessionId);
              if (gen !== resumeGen) return; // newer resume arrived while loading
              found = loadSession(msg.sessionId, messages);
            }
            if (gen !== resumeGen) return;
            target = found;
          } else {
            // No session ID = fresh session.
            // On first resume (no prior subscription) reuse the per-connection
            // session created at WS open. On subsequent null-resumes (e.g.
            // clicking 新對話 in the UI) always create a brand-new session.
            target = unsubscribe ? newSession() : session;
          }
          subscribeTo(target);
          sendSessionSnapshot();
          break;
        }

        case "chat": {
          if (msg.sessionId && msg.sessionId !== session.id) {
            let target = getSession(msg.sessionId);
            if (!target) {
              const messages = await loadMessagesFromDisk(msg.sessionId);
              target = loadSession(msg.sessionId, messages);
            }
            subscribeTo(target);
          }

          if (session.status === "running") {
            send(connection, { type: "error", message: "Still processing previous message" });
            return;
          }

          if (!unsubscribe) subscribeTo(session);

          // Resolve uploaded images from store
          const resolvedImages = (msg.imageIds ?? [])
            .map(id => getImage(id))
            .filter((img): img is NonNullable<typeof img> => img !== undefined);
          const thumbnails = resolvedImages.map(img => img.thumbnail);

          session.messages.push({
            role: "user",
            content: msg.message,
            timestamp: Date.now(),
            ...(thumbnails.length > 0 ? { images: thumbnails } : {}),
          });
          session.streaming = "";
          session.status = "running";

          const { systemPrompt } = await getSettings();

          // Snapshot session reference — fire-and-forget must not capture the
          // mutable `session` variable, which could be reassigned by a later
          // subscribeTo() call on this same WS connection.
          const activeSession = session;
          const imageInputs = resolvedImages.map(img => ({ base64: img.base64, mediaType: img.mediaType }));

          runClaude(activeSession.id, msg.message, activeSession.messages.slice(0, -1), (text) => {
            activeSession.streaming += text;
            broadcast(activeSession, { type: "chunk", text });
          }, systemPrompt, imageInputs.length > 0 ? imageInputs : undefined)
            .then(() => {
              activeSession.lastRunFinishedAt = Date.now();
              activeSession.messages.push({ role: "assistant", content: activeSession.streaming, timestamp: Date.now() });
              activeSession.streaming = "";
              activeSession.status = "idle";
              broadcast(activeSession, { type: "done" });
              // Persist this session in meta so it survives server restarts.
              // preview = first user message; updatedAt = now.
              const firstUser = activeSession.messages.find(m => m.role === "user");
              void setSessionMeta(activeSession.id, {
                source: "claudecode-remote",
                preview: firstUser?.content.replace(/\s+/g, " ").trim().slice(0, 80),
                updatedAt: activeSession.lastRunFinishedAt,
              });
            })
            .catch((err: Error) => {
              activeSession.lastRunFinishedAt = Date.now();
              const message = err.message;
              activeSession.messages.push({ role: "assistant", content: `Error: ${message}`, timestamp: Date.now() });
              activeSession.streaming = "";
              activeSession.status = "error";
              broadcast(activeSession, { type: "error", message });
            });
          break;
        }
      }
    });

    connection.on("close", () => {
      if (unsubscribe) unsubscribe();
      console.log(`[ws] client disconnected (session ${session.id}) — CLI continues in background`);
    });
  });
}

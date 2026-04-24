import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { runClaude, type ImageInput } from "./claude.js";
import { getSettings } from "./settings.js";
import { loadMessagesFromDisk } from "./session.js";
import {
  newSession,
  getSession,
  loadSession,
  broadcast,
  cooldownRemaining,
  type SessionState,
  type SessionEvent,
} from "./store.js";

type ClientMsg =
  | { type: "ping" }
  | { type: "resume"; sessionId?: string | null }
  | { type: "chat"; message: string; sessionId?: string | null; images?: ImageInput[] };

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
          let target = msg.sessionId ? getSession(msg.sessionId) : undefined;
          if (!target && msg.sessionId) {
            // Load session history from disk (Claude CLI JSONL)
            const messages = await loadMessagesFromDisk(msg.sessionId);
            target = loadSession(msg.sessionId, messages);
          }
          subscribeTo(target ?? session);
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

          session.messages.push({ role: "user", content: msg.message, timestamp: Date.now() });
          session.streaming = "";
          session.status = "running";

          const { systemPrompt } = await getSettings();

          // Respect CLI session-lock cooldown to avoid "session already in use"
          const wait = cooldownRemaining(session);
          if (wait > 0) await new Promise(r => setTimeout(r, wait));

          // Snapshot session reference — fire-and-forget must not capture the
          // mutable `session` variable, which could be reassigned by a later
          // subscribeTo() call on this same WS connection.
          const activeSession = session;

          runClaude(msg.message, activeSession.messages.slice(0, -1), (text) => {
            activeSession.streaming += text;
            broadcast(activeSession, { type: "chunk", text });
          }, systemPrompt, msg.images)
            .then(() => {
              activeSession.lastRunFinishedAt = Date.now();
              activeSession.messages.push({ role: "assistant", content: activeSession.streaming, timestamp: Date.now() });
              activeSession.streaming = "";
              activeSession.status = "idle";
              broadcast(activeSession, { type: "done" });
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

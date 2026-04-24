import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { runClaude } from "./claude.js";
import {
  newSession,
  getSession,
  broadcast,
  type SessionState,
  type SessionEvent,
} from "./store.js";

type ClientMsg =
  | { type: "ping" }
  | { type: "resume"; sessionId?: string | null }
  | { type: "chat"; message: string; sessionId?: string | null };

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

    // Announce connection; client should immediately reply with 'resume'
    send(connection, { type: "connected" });

    connection.on("message", (raw: Buffer) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw.toString()) as ClientMsg;
      } catch {
        return;
      }

      switch (msg.type) {
        case "ping":
          send(connection, { type: "pong" });
          break;

        case "resume": {
          const existing = msg.sessionId ? getSession(msg.sessionId) : undefined;
          subscribeTo(existing ?? session);
          sendSessionSnapshot();
          break;
        }

        case "chat": {
          // Switch session if the client provides a different ID
          if (msg.sessionId && msg.sessionId !== session.id) {
            const existing = getSession(msg.sessionId);
            if (existing) subscribeTo(existing);
          }

          if (session.status === "running") {
            send(connection, { type: "error", message: "Still processing previous message" });
            return;
          }

          // Ensure this connection is subscribed
          if (!unsubscribe) subscribeTo(session);

          const userMsg = { role: "user" as const, content: msg.message, timestamp: Date.now() };
          session.messages.push(userMsg);
          session.streaming = "";
          session.status = "running";

          // Fire-and-forget — CLI keeps running even if WebSocket closes
          runClaude(msg.message, session.id, (text) => {
            session.streaming += text;
            broadcast(session, { type: "chunk", text });
          })
            .then(() => {
              session.messages.push({
                role: "assistant",
                content: session.streaming,
                timestamp: Date.now(),
              });
              session.streaming = "";
              session.status = "idle";
              broadcast(session, { type: "done" });
            })
            .catch((err: Error) => {
              const message = err.message;
              session.messages.push({
                role: "assistant",
                content: `Error: ${message}`,
                timestamp: Date.now(),
              });
              session.streaming = "";
              session.status = "error";
              broadcast(session, { type: "error", message });
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

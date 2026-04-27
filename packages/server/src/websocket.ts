import type { FastifyInstance } from "fastify";
import type { WebSocket } from "@fastify/websocket";
import { runClaude, cancelSession, getProcessStatus } from "./claude.js";
import { createTask } from "./task-manager.js";
import { getImage } from "./image-store.js";
import { getSettings } from "./settings.js";
import { dbUpsertSession, dbInsertMessage, dbLoadMessages } from "./db.js";
import type { StoredMessage } from "./store.js";
import {
  newSession,
  getSession,
  loadSession,
  broadcast,
  type SessionState,
  type SessionEvent,
} from "./store.js";
import { taskEvents, TASK_EVENT_NAMES } from "./task-manager.js";

type ClientMsg =
  | { type: "ping" }
  | { type: "resume"; sessionId?: string | null }
  | { type: "cancel" }
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
        } else if (ev.type === "thinking") {
          send(connection, { type: "thinking", text: ev.text });
        } else if (ev.type === "done") {
          send(connection, { type: "done" });
        } else if (ev.type === "cancelled") {
          send(connection, { type: "cancelled" });
        } else if (ev.type === "reconnecting") {
          send(connection, { type: "reconnecting" });
        } else if (ev.type === "inject") {
          send(connection, { type: "inject", message: ev.message });
        } else {
          send(connection, { type: "error", message: (ev as { message: string }).message });
        }
      };
      session.subscribers.add(handler);
      unsubscribe = () => session.subscribers.delete(handler);
    }

    function sendSessionSnapshot(): void {
      // Sync session status with CLI process status to prevent stuck "processing" state
      // after reconnect (e.g., if process crashed or was cleaned up during disconnect).
      const processStatus = getProcessStatus(session.id);

      // If CLI process is idle but session thinks it's running, fix the session state.
      if (processStatus === "idle" && session.status === "running") {
        session.status = "idle";
        session.streaming = "";
      }

      // Additional guard: if streaming is empty and last run finished, status should be idle.
      const actualStatus = session.streaming === "" && session.lastRunFinishedAt > 0
        ? "idle"
        : session.status;

      send(connection, {
        type: "session",
        sessionId: session.id,
        messages: session.messages,
        streaming: session.streaming,
        status: actualStatus,
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

        case "cancel": {
          cancelSession(session.id);
          // cancelSession triggers reject("Cancelled") → .catch() → broadcast "cancelled"
          break;
        }

        case "resume": {
          const gen = ++resumeGen;
          let target: SessionState;
          if (msg.sessionId) {
            // Resume specific session — load from store or DB
            let found = getSession(msg.sessionId);
            if (!found) {
              const msgs: StoredMessage[] = dbLoadMessages(msg.sessionId).map(m => ({
                role: m.role as "user" | "assistant",
                content: m.content,
                timestamp: m.created_at,
                ...(m.images_json ? { images: JSON.parse(m.images_json) as string[] } : {}),
              }));
              if (gen !== resumeGen) return;
              found = loadSession(msg.sessionId, msgs);
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
              const msgs: StoredMessage[] = dbLoadMessages(msg.sessionId).map(m => ({
                role: m.role as "user" | "assistant",
                content: m.content,
                timestamp: m.created_at,
                ...(m.images_json ? { images: JSON.parse(m.images_json) as string[] } : {}),
              }));
              target = loadSession(msg.sessionId, msgs);
            }
            subscribeTo(target);
          }

          // Sync session status with CLI process status before the check.
          // If the process is idle but session thinks it's still running (e.g., unexpected
          // process exit without proper cleanup, or error in the .then() handler), recover
          // gracefully so the next message is not permanently blocked.
          if (session.status === "running" && getProcessStatus(session.id) === "idle") {
            session.status = "idle";
            session.streaming = "";
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

          const userMsg = {
            role: "user" as const,
            content: msg.message,
            timestamp: Date.now(),
            ...(thumbnails.length > 0 ? { images: thumbnails } : {}),
          };
          session.messages.push(userMsg);
          session.streaming = "";
          session.status = "running";

          // Snapshot session reference before any async yield — must not capture
          // the mutable `session` variable which could be reassigned by a later
          // subscribeTo() call on this same WS connection.
          const activeSession = session;

          // Persist user message to DB — best-effort, must not block runClaude
          const firstUserContent = activeSession.messages.find(m => m.role === "user")?.content
            .replace(/\s+/g, " ").trim().slice(0, 80);
          try {
            dbUpsertSession(activeSession.id, { preview: firstUserContent });
            dbInsertMessage(activeSession.id, "user", msg.message, thumbnails.length > 0 ? thumbnails : undefined);
          } catch (dbErr) {
            console.error("[ws] DB write error (user msg):", dbErr);
          }

          let systemPrompt = "";
          try { ({ systemPrompt } = await getSettings()); } catch { /* use default */ }

          const imageInputs = resolvedImages.map(img => ({ base64: img.base64, mediaType: img.mediaType }));

          const doRun = () => runClaude(
            activeSession.id, msg.message, activeSession.messages.slice(0, -1),
            (text) => { activeSession.streaming += text; broadcast(activeSession, { type: "chunk", text }); },
            systemPrompt,
            imageInputs.length > 0 ? imageInputs : undefined,
            (text) => { broadcast(activeSession, { type: "thinking", text }); },
          );

          doRun()
            // 401 auto-retry: notify client, reset streaming, retry once
            .catch(async (err: Error) => {
              if (err.message.startsWith("AUTH_401")) {
                broadcast(activeSession, { type: "reconnecting" });
                activeSession.streaming = "";
                await new Promise(r => setTimeout(r, 1500));
                return doRun();
              }
              throw err;
            })
            .then(() => {
              activeSession.lastRunFinishedAt = Date.now();
              activeSession.status = "idle";  // Set idle FIRST so reconnect sees correct state
              const rawContent = activeSession.streaming;

              // Detect [DISPATCH:repoPath|prompt] or [DISPATCH:prompt] tags
              // repoPath|prompt uses pipe to safely handle Windows drive-letter paths (D:\...)
              const DISPATCH_RE = /\[DISPATCH:([^\]]+)\]/g;
              let dispatchMatch: RegExpExecArray | null;
              while ((dispatchMatch = DISPATCH_RE.exec(rawContent)) !== null) {
                const inner = dispatchMatch[1];
                const pipeIdx = inner.indexOf("|");
                const repoPath = pipeIdx >= 0 ? inner.slice(0, pipeIdx).trim() || undefined : undefined;
                const prompt   = pipeIdx >= 0 ? inner.slice(pipeIdx + 1).trim() : inner.trim();
                if (prompt) {
                  // createTask itself registers the task in pending-dispatch
                  // (see task-manager.ts), so no extra bookkeeping here.
                  createTask({ repoPath, prompt, parentSessionId: activeSession.id });
                  console.log(`[ws] auto-dispatch: "${prompt.slice(0, 60)}" repo=${repoPath ?? "default"}`);
                }
              }

              // Keep DISPATCH tags in the stored content. Stripping them server-side
              // hides past dispatches from the main agent on later turns — it sees its
              // own previous reply as a tag-free narrative ("我派遣了兩個任務") and
              // mimics that on the next turn, *describing* dispatch without emitting
              // [DISPATCH:...] tags. UI strips for display in App.tsx; AI sees raw.
              const content = rawContent.trimEnd();

              activeSession.messages.push({ role: "assistant", content, timestamp: Date.now() });
              activeSession.streaming = "";
              broadcast(activeSession, { type: "done" });
              try {
                dbInsertMessage(activeSession.id, "assistant", content);
                dbUpsertSession(activeSession.id, { updatedAt: activeSession.lastRunFinishedAt });
              } catch (dbErr) {
                console.error("[ws] DB write error (assistant msg):", dbErr);
              }
            })
            .catch((err: Error) => {
              activeSession.lastRunFinishedAt = Date.now();
              activeSession.streaming = "";

              if (err.message === "Cancelled") {
                // Clean cancel: no error message, status back to idle
                activeSession.status = "idle";
                broadcast(activeSession, { type: "cancelled" });
                return;
              }

              const message = err.message;
              activeSession.messages.push({ role: "assistant", content: `Error: ${message}`, timestamp: Date.now() });
              activeSession.status = "error";
              broadcast(activeSession, { type: "error", message });
              try {
                dbInsertMessage(activeSession.id, "assistant", `Error: ${message}`);
              } catch (dbErr) {
                console.error("[ws] DB write error (error msg):", dbErr);
              }
            });
          break;
        }
      }
    });

    // Forward all task events to this WS client
    const forwardTask = (data: unknown) => send(connection, data);
    for (const ev of TASK_EVENT_NAMES) taskEvents.on(ev, forwardTask);

    connection.on("close", () => {
      if (unsubscribe) unsubscribe();
      for (const ev of TASK_EVENT_NAMES) taskEvents.off(ev, forwardTask);
      console.log(`[ws] client disconnected (session ${session.id}) — CLI continues in background`);
    });
  });
}

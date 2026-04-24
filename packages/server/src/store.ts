import { randomUUID } from "node:crypto";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type SessionStatus = "idle" | "running" | "error";

// Event types broadcast to WebSocket subscribers
export type SessionEvent =
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface SessionState {
  id: string;
  messages: StoredMessage[];
  /** Chunks accumulated from the currently-running CLI call */
  streaming: string;
  status: SessionStatus;
  subscribers: Set<(ev: SessionEvent) => void>;
}

const sessions = new Map<string, SessionState>();

export function newSession(): SessionState {
  const state: SessionState = {
    id: randomUUID(),
    messages: [],
    streaming: "",
    status: "idle",
    subscribers: new Set(),
  };
  sessions.set(state.id, state);
  return state;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function broadcast(session: SessionState, ev: SessionEvent): void {
  for (const sub of session.subscribers) {
    try {
      sub(ev);
    } catch { /* subscriber may have closed */ }
  }
}

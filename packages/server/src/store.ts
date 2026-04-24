import { randomUUID } from "node:crypto";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export type SessionStatus = "idle" | "running" | "error";

export type SessionEvent =
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface SessionState {
  id: string;
  messages: StoredMessage[];
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

/** Create a session pre-populated with messages loaded from disk. */
export function loadSession(id: string, messages: StoredMessage[]): SessionState {
  const existing = sessions.get(id);
  if (existing) return existing;
  const state: SessionState = { id, messages, streaming: "", status: "idle", subscribers: new Set() };
  sessions.set(id, state);
  return state;
}

export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function broadcast(session: SessionState, ev: SessionEvent): void {
  for (const sub of session.subscribers) {
    try { sub(ev); } catch { /* subscriber closed */ }
  }
}

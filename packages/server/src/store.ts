import { randomUUID } from "node:crypto";

export interface StoredMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  images?: string[]; // thumbnail data URLs for user messages with attached images
}

export type SessionStatus = "idle" | "running" | "error";

export type SessionEvent =
  | { type: "chunk"; text: string }
  | { type: "thinking"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface SessionState {
  id: string;
  messages: StoredMessage[];
  streaming: string;
  status: SessionStatus;
  lastRunFinishedAt: number; // epoch ms — guard against "session already in use" races
  subscribers: Set<(ev: SessionEvent) => void>;
}

const sessions = new Map<string, SessionState>();

export function newSession(): SessionState {
  const state: SessionState = {
    id: randomUUID(),
    messages: [],
    streaming: "",
    status: "idle",
    lastRunFinishedAt: 0,
    subscribers: new Set(),
  };
  sessions.set(state.id, state);
  return state;
}

/** Create a session pre-populated with messages loaded from disk. */
export function loadSession(id: string, messages: StoredMessage[]): SessionState {
  const existing = sessions.get(id);
  if (existing) return existing;
  // If loading from DB and last message is from assistant, mark as finished
  const lastMsg = messages[messages.length - 1];
  const lastRunFinishedAt = lastMsg?.role === "assistant" ? lastMsg.timestamp : 0;
  const state: SessionState = { id, messages, streaming: "", status: "idle", lastRunFinishedAt, subscribers: new Set() };
  sessions.set(id, state);
  return state;
}


export function getSession(id: string): SessionState | undefined {
  return sessions.get(id);
}

export function listSessions(): SessionState[] {
  return Array.from(sessions.values());
}

export function broadcast(session: SessionState, ev: SessionEvent): void {
  for (const sub of session.subscribers) {
    try { sub(ev); } catch { /* subscriber closed */ }
  }
}

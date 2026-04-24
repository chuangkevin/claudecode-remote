import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Settings {
  systemPrompt: string;
}

export interface SessionMeta {
  name?: string;
  pinned?: boolean;
  source?: "claudecode-remote"; // marks sessions created by this server
  preview?: string;             // first user message, for sidebar display
  updatedAt?: number;           // epoch ms of last completed response
}

/** Shape of the persisted JSON file (a superset of Settings). */
interface PersistedFile extends Settings {
  sessions?: Record<string, SessionMeta>;
}

const SETTINGS_PATH = join(homedir(), ".claude", "claudecode-remote.json");

const defaults: Settings = { systemPrompt: "" };

async function readFile_(): Promise<PersistedFile> {
  try {
    return { ...defaults, ...(JSON.parse(await readFile(SETTINGS_PATH, "utf8")) as Partial<PersistedFile>) };
  } catch {
    return { ...defaults };
  }
}

async function writeFile_(data: PersistedFile): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(data, null, 2), "utf8");
}

export async function getSettings(): Promise<Settings> {
  const f = await readFile_();
  return { systemPrompt: f.systemPrompt };
}

export async function saveSettings(settings: Settings): Promise<void> {
  const f = await readFile_();
  await writeFile_({ ...f, systemPrompt: settings.systemPrompt });
}

// ── Session metadata ──────────────────────────────────────────────────────────

export async function getAllSessionMeta(): Promise<Record<string, SessionMeta>> {
  const f = await readFile_();
  return f.sessions ?? {};
}

export async function setSessionMeta(id: string, patch: Partial<SessionMeta>): Promise<void> {
  const f = await readFile_();
  const sessions = { ...(f.sessions ?? {}), [id]: { ...(f.sessions?.[id] ?? {}), ...patch } };
  // Remove name if empty string was saved
  if (sessions[id].name === "") delete sessions[id].name;
  await writeFile_({ ...f, sessions });
}

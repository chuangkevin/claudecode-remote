import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import type { StoredMessage } from "./store.js";

const PROJECTS_DIR = join(homedir(), ".claude", "projects");

export interface DiskSession {
  id: string;
  preview: string;   // first user message, truncated
  updatedAt: number; // file mtime ms
}

// ── JSONL helpers ─────────────────────────────────────────────────────────────

function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .filter(b => b.type === "text")
      .map(b => b.text ?? "")
      .join("");
  }
  return "";
}

interface JournalEntry {
  type: string;
  message?: { role?: string; content?: unknown };
  timestamp?: string;
}

function parseJournal(raw: string): StoredMessage[] {
  const messages: StoredMessage[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry: JournalEntry;
    try { entry = JSON.parse(trimmed) as JournalEntry; } catch { continue; }

    if (entry.type === "user" && entry.message?.role === "user") {
      const text = extractText(entry.message.content).trim();
      if (text) {
        messages.push({
          role: "user",
          content: text,
          timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
        });
      }
    } else if (entry.type === "assistant" && entry.message?.role === "assistant") {
      const text = extractText(entry.message.content).trim();
      if (text) {
        messages.push({
          role: "assistant",
          content: text,
          timestamp: entry.timestamp ? Date.parse(entry.timestamp) : Date.now(),
        });
      }
    }
  }
  return messages;
}

// ── Public API ────────────────────────────────────────────────────────────────

export async function listDiskSessions(): Promise<DiskSession[]> {
  const sessions: DiskSession[] = [];
  let projectDirs: string[];
  try {
    projectDirs = await readdir(PROJECTS_DIR);
  } catch {
    return [];
  }

  for (const dir of projectDirs) {
    const dirPath = join(PROJECTS_DIR, dir);
    let files: string[];
    try {
      const s = await stat(dirPath);
      if (!s.isDirectory()) continue;
      files = await readdir(dirPath);
    } catch { continue; }

    for (const file of files) {
      if (!file.endsWith(".jsonl")) continue;
      const id = file.slice(0, -6); // strip .jsonl
      const filePath = join(dirPath, file);
      try {
        const fileStat = await stat(filePath);
        // Read only first 4 KB for preview (avoid loading huge files)
        const fd = await readFile(filePath, { encoding: "utf8" });
        const firstLines = fd.slice(0, 4096).split("\n");
        let preview = "";
        for (const line of firstLines) {
          if (!line.trim()) continue;
          let e: JournalEntry;
          try { e = JSON.parse(line) as JournalEntry; } catch { continue; }
          if (e.type === "user" && e.message?.role === "user") {
            preview = extractText(e.message.content).replace(/\s+/g, " ").trim().slice(0, 80);
            break;
          }
        }
        sessions.push({ id, preview: preview || id, updatedAt: fileStat.mtimeMs });
      } catch { continue; }
    }
  }

  // Sort newest first
  return sessions.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadMessagesFromDisk(sessionId: string): Promise<StoredMessage[]> {
  let projectDirs: string[];
  try { projectDirs = await readdir(PROJECTS_DIR); } catch { return []; }

  for (const dir of projectDirs) {
    const filePath = join(PROJECTS_DIR, dir, `${sessionId}.jsonl`);
    try {
      const raw = await readFile(filePath, "utf8");
      return parseJournal(raw);
    } catch { continue; }
  }
  return [];
}

import Database from "better-sqlite3";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { config } from "./config.js";

let _db: Database.Database | null = null;

export function initDb(): void {
  const dbPath = join(config.claudeDataDir, "claudecode-remote.db");
  _db = new Database(dbPath);
  _db.pragma("journal_mode = WAL");
  _db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id         TEXT    PRIMARY KEY,
      name       TEXT,
      pinned     INTEGER NOT NULL DEFAULT 0,
      preview    TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT    NOT NULL,
      role        TEXT    NOT NULL,
      content     TEXT    NOT NULL,
      images_json TEXT,
      created_at  INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_msg_session ON messages(session_id, created_at);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id            TEXT    PRIMARY KEY,
      repo_path     TEXT    NOT NULL,
      worktree_name TEXT,
      branch_name   TEXT,
      prompt        TEXT    NOT NULL,
      status        TEXT    NOT NULL DEFAULT 'running',
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_messages (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id    TEXT    NOT NULL,
      role       TEXT    NOT NULL,
      content    TEXT    NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_task_msg ON task_messages(task_id, created_at);
  `);
}

function db(): Database.Database {
  if (!_db) throw new Error("DB not initialized — call initDb() first");
  return _db;
}

// ── Sessions ──────────────────────────────────────────────────────────────────

export interface DbSession {
  id: string;
  name: string | null;
  pinned: number;
  preview: string | null;
  created_at: number;
  updated_at: number;
}

/** Ensure session row exists, then apply any field patches. */
export function dbUpsertSession(id: string, fields: {
  name?: string | null;
  pinned?: boolean;
  preview?: string | null;
  updatedAt?: number;
} = {}): void {
  const now = fields.updatedAt ?? Date.now();
  db().prepare(
    `INSERT OR IGNORE INTO sessions (id, name, pinned, preview, created_at, updated_at)
     VALUES (@id, NULL, 0, NULL, @now, @now)`
  ).run({ id, now });

  // Build SET clause dynamically to avoid overwriting untouched columns
  const parts: string[] = ["updated_at = @now"];
  if ("name" in fields)   parts.push("name = @name");
  if ("pinned" in fields) parts.push("pinned = @pinned");
  if ("preview" in fields) parts.push("preview = @preview");

  db().prepare(`UPDATE sessions SET ${parts.join(", ")} WHERE id = @id`).run({
    id,
    now,
    name:    "name"    in fields ? (fields.name    ?? null) : null,
    pinned:  "pinned"  in fields ? (fields.pinned  ? 1 : 0) : 0,
    preview: "preview" in fields ? (fields.preview ?? null) : null,
  });
}

export function dbLoadAllSessions(): DbSession[] {
  return db()
    .prepare(`SELECT * FROM sessions ORDER BY pinned DESC, updated_at DESC`)
    .all() as DbSession[];
}

// ── Messages ──────────────────────────────────────────────────────────────────

export interface DbMessage {
  id: number;
  session_id: string;
  role: string;
  content: string;
  images_json: string | null;
  created_at: number;
}

export function dbInsertMessage(
  sessionId: string,
  role: string,
  content: string,
  images?: string[],
): void {
  const now = Date.now();
  db().prepare(
    `INSERT INTO messages (session_id, role, content, images_json, created_at)
     VALUES (@sessionId, @role, @content, @images, @now)`
  ).run({
    sessionId,
    role,
    content,
    images: images?.length ? JSON.stringify(images) : null,
    now,
  });
  db().prepare(`UPDATE sessions SET updated_at = @now WHERE id = @id`).run({ now, id: sessionId });
}

export function dbLoadMessages(sessionId: string): DbMessage[] {
  return db()
    .prepare(`SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC`)
    .all(sessionId) as DbMessage[];
}

// ── Settings ──────────────────────────────────────────────────────────────────

export function dbGetSetting(key: string): string | null {
  const row = db().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

export function dbSetSetting(key: string, value: string): void {
  db().prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(key, value);
}

// ── Tasks ─────────────────────────────────────────────────────────────────────

export interface DbTask {
  id: string;
  repo_path: string;
  worktree_name: string | null;
  branch_name: string | null;
  prompt: string;
  status: string;
  created_at: number;
  updated_at: number;
}

export function dbInsertTask(t: {
  id: string; repoPath: string; worktreeName: string | null;
  branchName: string | null; prompt: string; status: string; createdAt: number;
}): void {
  const now = t.createdAt;
  db().prepare(`
    INSERT INTO tasks (id, repo_path, worktree_name, branch_name, prompt, status, created_at, updated_at)
    VALUES (@id, @repoPath, @worktreeName, @branchName, @prompt, @status, @now, @now)
  `).run({ id: t.id, repoPath: t.repoPath, worktreeName: t.worktreeName ?? null,
           branchName: t.branchName ?? null, prompt: t.prompt, status: t.status, now });
}

export function dbUpdateTask(id: string, fields: { status?: string; updatedAt?: number }): void {
  const now = fields.updatedAt ?? Date.now();
  const parts = ["updated_at = @now"];
  if ("status" in fields) parts.push("status = @status");
  db().prepare(`UPDATE tasks SET ${parts.join(", ")} WHERE id = @id`)
    .run({ id, now, status: fields.status ?? "running" });
}

export function dbLoadAllTasks(): DbTask[] {
  return db().prepare(`SELECT * FROM tasks ORDER BY created_at DESC`).all() as DbTask[];
}

export interface DbTaskMessage {
  id: number; task_id: string; role: string; content: string; created_at: number;
}

export function dbInsertTaskMessage(taskId: string, role: string, content: string): void {
  db().prepare(`INSERT INTO task_messages (task_id, role, content, created_at) VALUES (?, ?, ?, ?)`)
    .run(taskId, role, content, Date.now());
  db().prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(Date.now(), taskId);
}

export function dbLoadTaskMessages(taskId: string): DbTaskMessage[] {
  return db().prepare(`SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC`)
    .all(taskId) as DbTaskMessage[];
}

export function dbDeleteTask(id: string): void {
  db().prepare(`DELETE FROM task_messages WHERE task_id = ?`).run(id);
  db().prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

// ── Migration from JSON ───────────────────────────────────────────────────────

export function migrateFromJson(jsonPath: string): void {
  let raw: string;
  try { raw = readFileSync(jsonPath, "utf8"); } catch { return; }

  let data: {
    systemPrompt?: string;
    sessions?: Record<string, {
      name?: string; pinned?: boolean; source?: string; preview?: string; updatedAt?: number;
    }>;
  };
  try { data = JSON.parse(raw) as typeof data; } catch { return; }

  if (data.systemPrompt && !dbGetSetting("systemPrompt")) {
    dbSetSetting("systemPrompt", data.systemPrompt);
    console.log("[db] migrated systemPrompt from JSON");
  }

  if (data.sessions) {
    const insert = db().prepare(
      `INSERT OR IGNORE INTO sessions (id, name, pinned, preview, created_at, updated_at)
       VALUES (@id, @name, @pinned, @preview, @now, @updated_at)`
    );
    const migrate = db().transaction(() => {
      for (const [id, meta] of Object.entries(data.sessions!)) {
        if (meta.source !== "claudecode-remote") continue;
        insert.run({
          id,
          name: meta.name ?? null,
          pinned: meta.pinned ? 1 : 0,
          preview: meta.preview ?? null,
          now: Date.now(),
          updated_at: meta.updatedAt ?? Date.now(),
        });
      }
    });
    migrate();
    console.log("[db] migrated session metadata from JSON");
  }
}

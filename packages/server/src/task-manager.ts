import { randomUUID } from "node:crypto";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join, basename } from "node:path";
import { EventEmitter } from "node:events";
import { config } from "./config.js";
import {
  dbInsertTask, dbUpdateTask, dbLoadAllTasks, dbLoadTaskMessages,
  dbInsertTaskMessage, dbDeleteTask,
} from "./db.js";

export const MAX_CONCURRENT = 20;
export type TaskStatus = "running" | "done" | "error" | "cancelled";

export interface TaskMessage {
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

export interface TaskInfo {
  id: string;
  repoPath: string;
  worktreeName: string | null;
  branchName: string | null;
  prompt: string;
  status: TaskStatus;
  messages: TaskMessage[];
  streaming: string;
  createdAt: number;
  updatedAt: number;
  parentSessionId?: string;
}

interface ActiveTask extends TaskInfo {
  worktreePath: string;
  proc: ChildProcess | null;
  buf: string;
  emittedLength: number;
}

// All connected WS clients subscribe to this emitter
export const taskEvents = new EventEmitter();
taskEvents.setMaxListeners(200);

const activeTasks = new Map<string, ActiveTask>();

function runningCount(): number {
  return Array.from(activeTasks.values()).filter(t => t.status === "running").length;
}

function sanitizeBranch(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 28);
}

function isGitRepo(path: string): boolean {
  try {
    execSync(`git -C "${path}" rev-parse --git-dir`, { stdio: "pipe", timeout: 5_000 });
    return true;
  } catch { return false; }
}

function tryCreateWorktree(repoPath: string, wtPath: string, branch: string): boolean {
  try {
    execSync(`git -C "${repoPath}" worktree add "${wtPath}" -b "${branch}"`, { stdio: "pipe", timeout: 15_000 });
    return true;
  } catch { return false; }
}

function tryRemoveWorktree(repoPath: string, wtPath: string): void {
  try {
    execSync(`git -C "${repoPath}" worktree remove "${wtPath}" --force`, { stdio: "pipe", timeout: 10_000 });
  } catch { /* ignore */ }
}

function processLine(task: ActiveTask, line: string): void {
  const trimmed = line.trim();
  if (!trimmed) return;
  let ev: { type: string; [k: string]: unknown };
  try { ev = JSON.parse(trimmed) as typeof ev; } catch { return; }

  if (ev.type === "assistant") {
    type Block = { type: string; text?: string };
    const content = (ev.message as { content?: Block[] })?.content ?? [];
    let fullText = "";
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") fullText += block.text;
    }
    if (fullText.length > task.emittedLength) {
      const delta = fullText.slice(task.emittedLength);
      task.streaming += delta;
      task.emittedLength = fullText.length;
      taskEvents.emit("task:progress", { type: "task:progress", taskId: task.id, text: delta });
    }
  } else if (ev.type === "result") {
    finishTask(task, "done");
  } else if (ev.type === "error") {
    const msg = typeof ev.message === "string" ? ev.message : "Task error";
    finishTask(task, "error", msg);
  }
}

function finishTask(task: ActiveTask, status: TaskStatus, errorMsg?: string): void {
  if (task.status !== "running") return; // guard double-fire
  const content = task.streaming;
  task.status = status;
  task.updatedAt = Date.now();
  task.streaming = "";
  task.emittedLength = 0;

  if (content) {
    const msg: TaskMessage = { role: "assistant", content, timestamp: Date.now() };
    task.messages.push(msg);
    try { dbInsertTaskMessage(task.id, "assistant", content); } catch { /* best-effort */ }
  } else if (status === "error" && errorMsg) {
    const msg: TaskMessage = { role: "assistant", content: `Error: ${errorMsg}`, timestamp: Date.now() };
    task.messages.push(msg);
    try { dbInsertTaskMessage(task.id, "assistant", `Error: ${errorMsg}`); } catch { /* best-effort */ }
  }

  try { dbUpdateTask(task.id, { status, updatedAt: task.updatedAt }); } catch { /* best-effort */ }

  const evType = status === "done" ? "task:done"
    : status === "cancelled" ? "task:cancelled"
    : "task:error";
  taskEvents.emit(evType, {
    type: evType,
    taskId: task.id,
    ...(task.parentSessionId ? { parentSessionId: task.parentSessionId } : {}),
    ...(errorMsg ? { message: errorMsg } : {}),
  });
  console.log(`[task] ${task.id.slice(0, 8)} finished → ${status}`);
}

// ── Public API ────────────────────────────────────────────────────────────────

export function createTask(params: { repoPath?: string; prompt: string; parentSessionId?: string }): TaskInfo | { error: string } {
  if (runningCount() >= MAX_CONCURRENT) {
    return { error: `已達最大並行上限 (${MAX_CONCURRENT})` };
  }

  const repoPath = params.repoPath?.trim() || config.workspaceRoot;
  const isRepo = isGitRepo(repoPath);
  const taskId = randomUUID();
  const slug = sanitizeBranch(params.prompt.slice(0, 20));
  const branchName = isRepo ? `task/${slug}-${taskId.slice(0, 6)}` : null;
  const worktreeName = isRepo ? `wt-${taskId.slice(0, 8)}` : null;

  let worktreePath = repoPath;
  let actualWorktreeName: string | null = null;
  let actualBranch: string | null = null;

  if (isRepo && worktreeName && branchName) {
    const wtDir = join(repoPath, ".worktrees");
    try { mkdirSync(wtDir, { recursive: true }); } catch { /* ignore */ }
    const wtPath = join(wtDir, worktreeName);
    if (tryCreateWorktree(repoPath, wtPath, branchName)) {
      worktreePath = wtPath;
      actualWorktreeName = worktreeName;
      actualBranch = branchName;
    }
    // If worktree creation fails, fall back to running in repoPath directly
  }

  const now = Date.now();
  const task: ActiveTask = {
    id: taskId,
    repoPath,
    worktreePath,
    worktreeName: actualWorktreeName,
    branchName: actualBranch,
    prompt: params.prompt,
    status: "running",
    messages: [{ role: "user", content: params.prompt, timestamp: now }],
    streaming: "",
    createdAt: now,
    updatedAt: now,
    proc: null,
    buf: "",
    emittedLength: 0,
    ...(params.parentSessionId ? { parentSessionId: params.parentSessionId } : {}),
  };
  activeTasks.set(taskId, task);

  try {
    dbInsertTask({ id: taskId, repoPath, worktreeName: actualWorktreeName,
                   branchName: actualBranch, prompt: params.prompt, status: "running", createdAt: now });
    dbInsertTaskMessage(taskId, "user", params.prompt);
  } catch (e) { console.error("[task] DB insert error:", e); }

  // Spawn Claude CLI
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;

  const child = spawn("claude", [
    "--print", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages",
    "--session-id", randomUUID(),
    "--no-session-persistence",
    "--input-format", "stream-json",
    "--dangerously-skip-permissions",
  ], {
    cwd: worktreePath,
    stdio: ["pipe", "pipe", "pipe"],
    shell: process.platform === "win32",
    windowsHide: true,
    env,
  });

  child.stdin.on("error", () => {});
  task.proc = child;

  child.stdout.on("data", (chunk: Buffer) => {
    task.buf += chunk.toString("utf8");
    const lines = task.buf.split("\n");
    task.buf = lines.pop() ?? "";
    for (const line of lines) processLine(task, line);
  });

  child.stderr.on("data", (d: Buffer) => {
    const text = d.toString("utf8").trim();
    if (text) console.error(`[task:${taskId.slice(0, 8)}] stderr:`, text.split("\n")[0]);
  });

  child.on("error", (err) => {
    console.error(`[task] spawn error:`, err.message);
    finishTask(task, "error", err.message);
  });

  child.on("exit", (code) => {
    if (task.buf.trim()) processLine(task, task.buf);
    finishTask(task, task.status === "running" ? "error" : task.status,
               task.status === "running" ? `Process exited with code ${code}` : undefined);
  });

  // Send prompt to CLI
  child.stdin!.write(
    JSON.stringify({ type: "user", message: { role: "user", content: params.prompt } }) + "\n",
    "utf8",
  );

  const repoLabel = basename(repoPath);
  taskEvents.emit("task:created", {
    type: "task:created",
    taskId, repoPath, repoLabel,
    worktreeName: actualWorktreeName,
    branchName: actualBranch,
    prompt: params.prompt,
    createdAt: now,
  });
  console.log(`[task] ${taskId.slice(0, 8)} created in ${worktreePath}`);
  return toInfo(task);
}

export function cancelTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task || task.status !== "running") return false;
  try { task.proc?.kill(); } catch { /* ignore */ }
  finishTask(task, "cancelled");
  return true;
}

export function deleteTask(taskId: string): boolean {
  const task = activeTasks.get(taskId);
  if (!task) return false;
  if (task.status === "running") {
    try { task.proc?.kill(); } catch { /* ignore */ }
    task.status = "cancelled"; // guard finishTask double-fire
  }
  if (task.worktreeName) tryRemoveWorktree(task.repoPath, task.worktreePath);
  activeTasks.delete(taskId);
  try { dbDeleteTask(taskId); } catch { /* best-effort */ }
  console.log(`[task] ${taskId.slice(0, 8)} deleted`);
  return true;
}

export function getTask(taskId: string): TaskInfo | undefined {
  const t = activeTasks.get(taskId);
  return t ? toInfo(t) : undefined;
}

export function listTasks(): TaskInfo[] {
  return Array.from(activeTasks.values()).map(toInfo)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/** Called at server startup — loads DB tasks into memory, marks stale "running" as "error". */
export function loadTasksFromDb(): void {
  const rows = dbLoadAllTasks();
  for (const row of rows) {
    const status: TaskStatus = row.status === "running" ? "error" : row.status as TaskStatus;
    if (row.status === "running") {
      try { dbUpdateTask(row.id, { status: "error" }); } catch { /* ignore */ }
    }
    const msgs = dbLoadTaskMessages(row.id).map(m => ({
      role: m.role as "user" | "assistant",
      content: m.content,
      timestamp: m.created_at,
    }));
    const task: ActiveTask = {
      id: row.id,
      repoPath: row.repo_path,
      worktreePath: row.repo_path,
      worktreeName: row.worktree_name,
      branchName: row.branch_name,
      prompt: row.prompt,
      status,
      messages: msgs,
      streaming: "",
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      proc: null,
      buf: "",
      emittedLength: 0,
    };
    activeTasks.set(row.id, task);
  }
  console.log(`[task] loaded ${rows.length} tasks from DB`);
}

function toInfo(task: ActiveTask): TaskInfo {
  const { proc, buf, emittedLength, worktreePath: _wtp, ...info } = task;
  void proc; void buf; void emittedLength; void _wtp;
  return info;
}

export const TASK_EVENT_NAMES = [
  "task:created", "task:progress", "task:done", "task:error", "task:cancelled",
] as const;

import { readFile, writeFile, readdir, stat, mkdir } from "fs/promises";
import { join, resolve } from "path";
import { existsSync } from "fs";
import { randomUUID } from "crypto";
import { config } from "./config.js";

export interface SessionMessage {
  role: "user" | "assistant";
  content: string | Array<{ type: string; text?: string; [key: string]: any }>;
  timestamp?: number;
}

export interface Session {
  id: string;
  projectPath: string;
  messages: SessionMessage[];
  createdAt: number;
  updatedAt: number;
}

function getProjectsDir(): string {
  return join(config.claudeDataDir, "projects");
}

function getProjectDir(projectPath: string): string {
  const normalized = projectPath.replace(/[:\\\/]/g, "-");
  return join(getProjectsDir(), normalized);
}

export async function listSessions(): Promise<string[]> {
  try {
    const projectsDir = getProjectsDir();
    if (!existsSync(projectsDir)) {
      return [];
    }

    const dirs = await readdir(projectsDir);
    const sessions: string[] = [];

    for (const dir of dirs) {
      const projectDir = join(projectsDir, dir);
      const projectStat = await stat(projectDir);
      if (projectStat.isDirectory()) {
        const files = await readdir(projectDir);
        for (const file of files) {
          if (file.endsWith(".jsonl")) {
            const sessionId = file.replace(".jsonl", "");
            sessions.push(sessionId);
          }
        }
      }
    }

    return sessions;
  } catch (error) {
    console.error("Failed to list sessions:", error);
    return [];
  }
}

export async function loadSession(
  sessionId: string,
  projectPath?: string
): Promise<Session | null> {
  try {
    const searchPath = projectPath ? getProjectDir(projectPath) : getProjectsDir();

    let sessionFilePath: string | null = null;

    if (projectPath) {
      const filePath = join(searchPath, `${sessionId}.jsonl`);
      if (existsSync(filePath)) {
        sessionFilePath = filePath;
      }
    } else {
      const dirs = await readdir(searchPath);
      for (const dir of dirs) {
        const filePath = join(searchPath, dir, `${sessionId}.jsonl`);
        if (existsSync(filePath)) {
          sessionFilePath = filePath;
          break;
        }
      }
    }

    if (!sessionFilePath) {
      return null;
    }

    const content = await readFile(sessionFilePath, "utf-8");
    const lines = content.trim().split("\n");
    const messages: SessionMessage[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        messages.push(msg);
      } catch (error) {
        console.error("Failed to parse session line:", error);
      }
    }

    const fileStat = await stat(sessionFilePath);

    return {
      id: sessionId,
      projectPath: projectPath || config.workspaceRoot,
      messages,
      createdAt: fileStat.birthtimeMs,
      updatedAt: fileStat.mtimeMs,
    };
  } catch (error) {
    console.error("Failed to load session:", error);
    return null;
  }
}

export async function saveMessage(
  sessionId: string,
  projectPath: string,
  message: SessionMessage
): Promise<void> {
  try {
    const projectDir = getProjectDir(projectPath);
    if (!existsSync(projectDir)) {
      await mkdir(projectDir, { recursive: true });
    }

    const sessionFilePath = join(projectDir, `${sessionId}.jsonl`);
    const messageLine = JSON.stringify({
      ...message,
      timestamp: message.timestamp || Date.now(),
    }) + "\n";

    await writeFile(sessionFilePath, messageLine, {
      flag: "a",
      encoding: "utf-8",
    });
  } catch (error) {
    console.error("Failed to save message:", error);
    throw error;
  }
}

export async function createSession(projectPath: string): Promise<string> {
  const sessionId = generateSessionId();
  const projectDir = getProjectDir(projectPath);

  if (!existsSync(projectDir)) {
    await mkdir(projectDir, { recursive: true });
  }

  const sessionFilePath = join(projectDir, `${sessionId}.jsonl`);
  await writeFile(sessionFilePath, "", "utf-8");

  return sessionId;
}

function generateSessionId(): string {
  // 使用 randomUUID() 生成標準 UUID
  return randomUUID();
}

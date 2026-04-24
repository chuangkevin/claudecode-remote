import { spawn } from "node:child_process";
import { config } from "./config.js";

type StreamEvent =
  | { type: "text"; text: string }
  | { type: string; [k: string]: unknown };

/**
 * Spawns `claude --print --output-format stream-json --session-id <id>`,
 * writes the user message to stdin, and calls onChunk for every text chunk
 * that arrives on stdout.
 *
 * The CLI process keeps running independently of the caller — callers should
 * not await this if they want fire-and-forget background behaviour.
 */
export function runClaude(
  userMessage: string,
  sessionId: string,
  onChunk: (text: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Strip any ANTHROPIC_API_KEY that the parent process may have set;
    // the CLI authenticates via its own OAuth credentials in ~/.claude.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--session-id", sessionId,
      "--dangerously-skip-permissions",
    ];

    // On Windows, npm global CLIs are .cmd files and require shell:true.
    // We pass the message via stdin to avoid any shell-quoting issues.
    const child = spawn("claude", args, {
      cwd: config.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
      env,
    });

    child.stdin.write(userMessage, "utf8");
    child.stdin.end();

    let buf = "";

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      // NDJSON: split on newlines, keep incomplete last line in buf
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const ev = JSON.parse(trimmed) as StreamEvent;
          if (ev.type === "text" && typeof (ev as { text?: unknown }).text === "string") {
            onChunk((ev as { type: "text"; text: string }).text);
          }
        } catch { /* non-JSON diagnostic line — ignore */ }
      }
    });

    child.stderr.on("data", (d: Buffer) => {
      const line = d.toString("utf8").trim();
      if (line) console.error("[claude]", line);
    });

    child.on("error", (err) => {
      console.error("[claude] spawn error:", err);
      reject(err);
    });

    child.on("exit", (code) => {
      // Flush any partial line still in the buffer
      const remaining = buf.trim();
      if (remaining) {
        try {
          const ev = JSON.parse(remaining) as StreamEvent;
          if (ev.type === "text" && typeof (ev as { text?: unknown }).text === "string") {
            onChunk((ev as { type: "text"; text: string }).text);
          }
        } catch { /* ignore */ }
      }
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`claude exited with code ${code}`));
      }
    });
  });
}

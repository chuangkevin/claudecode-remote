import { spawn } from "node:child_process";
import { config } from "./config.js";

// stream-json event shapes from Claude CLI
type AssistantEvent = {
  type: "assistant";
  message: {
    content: Array<{ type: string; text?: string }>;
  };
};
type AnyEvent = { type: string; [k: string]: unknown };

/**
 * Spawns `claude --print --output-format stream-json --verbose --include-partial-messages`,
 * writes the user message to stdin, and calls onChunk with text deltas as they arrive.
 *
 * The CLI process is fire-and-forget — it keeps running even if the caller
 * no longer holds a reference (WebSocket disconnect, etc.).
 *
 * Why --verbose: required by the CLI when using --output-format=stream-json.
 * Why --include-partial-messages: delivers assistant events incrementally so
 *   the browser sees tokens arrive in real time.
 */
export function runClaude(
  userMessage: string,
  sessionId: string,
  onChunk: (text: string) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // Strip any ANTHROPIC_API_KEY set by the parent environment; the CLI
    // authenticates via its own OAuth credentials stored in ~/.claude.
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--session-id", sessionId,
      "--dangerously-skip-permissions",
    ];

    // On Windows, npm global CLIs are .cmd shims that need shell:true.
    // Message is written to stdin to avoid any shell-quoting issues.
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
    // Track accumulated text across partial assistant events so we can
    // compute and forward only the new delta each time.
    let emittedLength = 0;

    function processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: AnyEvent;
      try {
        ev = JSON.parse(trimmed) as AnyEvent;
      } catch {
        return; // non-JSON diagnostic line
      }

      if (ev.type === "assistant") {
        const ae = ev as unknown as AssistantEvent;
        // Accumulate all text blocks in this (possibly partial) message
        let fullText = "";
        for (const block of ae.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            fullText += block.text;
          }
        }
        // Only emit the newly-arrived portion (delta)
        if (fullText.length > emittedLength) {
          onChunk(fullText.slice(emittedLength));
          emittedLength = fullText.length;
        }
      }
    }

    child.stdout.on("data", (chunk: Buffer) => {
      buf += chunk.toString("utf8");
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) processLine(line);
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
      // Flush any line still buffered
      if (buf.trim()) processLine(buf);
      if (code === 0) resolve();
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

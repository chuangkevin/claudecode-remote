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

export interface ImageInput {
  base64: string;
  mediaType: string; // e.g. "image/jpeg"
}

/**
 * Spawns `claude --print --output-format stream-json --verbose --include-partial-messages`.
 *
 * Text-only messages are written to stdin as plain text (default input format).
 * When an image is provided, switches to --input-format stream-json and writes
 * a multimodal JSON envelope so Claude receives both image and text.
 *
 * Why --append-system-prompt: adds user-configured context without replacing
 *   Claude Code's built-in system prompt.
 */
export function runClaude(
  userMessage: string,
  sessionId: string,
  onChunk: (text: string) => void,
  systemPrompt?: string,
  image?: ImageInput,
): Promise<void> {
  return new Promise((resolve, reject) => {
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

    if (systemPrompt?.trim()) {
      args.push("--append-system-prompt", systemPrompt.trim());
    }

    // Switch to stream-json input format when an image is attached
    if (image) {
      args.push("--input-format", "stream-json");
    }

    const child = spawn("claude", args, {
      cwd: config.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
      env,
    });

    if (image) {
      // Multimodal: JSON envelope with image block + text block
      const envelope = JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: image.mediaType, data: image.base64 },
            },
            { type: "text", text: userMessage },
          ],
        },
      });
      child.stdin.write(envelope + "\n", "utf8");
    } else {
      child.stdin.write(userMessage, "utf8");
    }
    child.stdin.end();

    let buf = "";
    let emittedLength = 0;

    function processLine(line: string): void {
      const trimmed = line.trim();
      if (!trimmed) return;
      let ev: AnyEvent;
      try {
        ev = JSON.parse(trimmed) as AnyEvent;
      } catch {
        return;
      }
      if (ev.type === "assistant") {
        const ae = ev as unknown as AssistantEvent;
        let fullText = "";
        for (const block of ae.message?.content ?? []) {
          if (block.type === "text" && typeof block.text === "string") {
            fullText += block.text;
          }
        }
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
      if (buf.trim()) processLine(buf);
      if (code === 0) resolve();
      else reject(new Error(`claude exited with code ${code}`));
    });
  });
}

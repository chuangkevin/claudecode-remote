import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { config } from "./config.js";
import type { StoredMessage } from "./store.js";

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

type Images = ImageInput | ImageInput[] | undefined;

/**
 * Build a contextual user message that embeds prior conversation turns.
 * The CLI stream-json input only accepts "user" type messages, so we cannot
 * inject assistant turns as separate lines. Instead we prepend history as a
 * formatted text block so the model sees full context.
 */
function buildContextualMessage(userMessage: string, previousMessages: StoredMessage[]): string {
  if (previousMessages.length === 0) return userMessage;
  const history = previousMessages
    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
  return `[Prior conversation]\n${history}\n\n[Current message]\n${userMessage}`;
}

/**
 * Spawns `claude --print --output-format stream-json --verbose --include-partial-messages`.
 *
 * Uses --no-session-persistence + a fresh UUID each invocation to avoid the
 * Windows CLI session-lock bug ("Session ID already in use").
 * Conversation history is embedded as a text prefix in the user message so
 * the model sees full context without on-disk session files.
 *
 * Why --append-system-prompt: adds user-configured context without replacing
 *   Claude Code's built-in system prompt.
 */
export function runClaude(
  userMessage: string,
  previousMessages: StoredMessage[],
  onChunk: (text: string) => void,
  systemPrompt?: string,
  imagesArg?: Images,
): Promise<void> {
  const images: ImageInput[] = imagesArg
    ? Array.isArray(imagesArg) ? imagesArg : [imagesArg]
    : [];
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY;

    const args = [
      "--print",
      "--output-format", "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--session-id", randomUUID(),
      "--no-session-persistence",
      "--input-format", "stream-json",
      "--dangerously-skip-permissions",
    ];

    const basePrompt = "請始終使用繁體中文回覆。";
    const fullPrompt = systemPrompt?.trim()
      ? `${basePrompt}\n${systemPrompt.trim()}`
      : basePrompt;
    args.push("--append-system-prompt", fullPrompt);

    const child = spawn("claude", args, {
      cwd: config.workspaceRoot,
      stdio: ["pipe", "pipe", "pipe"],
      shell: process.platform === "win32",
      windowsHide: true,
      env,
    });

    const contextualMessage = buildContextualMessage(userMessage, previousMessages);

    if (images.length > 0) {
      const contentBlocks = [
        ...images.map(img => ({
          type: "image",
          source: { type: "base64", media_type: img.mediaType, data: img.base64 },
        })),
        { type: "text", text: contextualMessage },
      ];
      child.stdin.write(JSON.stringify({
        type: "user",
        message: { role: "user", content: contentBlocks },
      }) + "\n", "utf8");
    } else {
      child.stdin.write(JSON.stringify({
        type: "user",
        message: { role: "user", content: contextualMessage },
      }) + "\n", "utf8");
    }

    child.stdin.on("error", () => {}); // suppress EPIPE if child exits before reading
    child.stdin.end();

    let buf = "";
    let stderrBuf = "";
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
      const text = d.toString("utf8");
      stderrBuf += text;
      const line = text.trim();
      if (line) console.error("[claude]", line);
    });

    child.on("error", (err) => {
      console.error("[claude] spawn error:", err);
      reject(err);
    });

    child.on("exit", (code) => {
      if (buf.trim()) processLine(buf);
      if (code === 0) {
        resolve();
      } else {
        const hint = stderrBuf.toLowerCase().includes("context")
          ? " (context too long — try starting a new conversation)"
          : stderrBuf.trim() ? ` — ${stderrBuf.trim().split("\n")[0]}` : "";
        reject(new Error(`claude exited with code ${code}${hint}`));
      }
    });
  });
}

import { dbGetSetting, dbSetSetting } from "./db.js";
import { DEFAULT_SYSTEM_PROMPT } from "./claude.js";
import { config } from "./config.js";

export interface Settings {
  /** User override; empty string means "use default". */
  systemPrompt: string;
  /** Built-in default with {{WORKSPACE_ROOT}} placeholder; read-only, for UI. */
  defaultSystemPrompt: string;
  /** Effective workspace root, used to resolve {{WORKSPACE_ROOT}} at runtime. */
  workspaceRoot: string;
}

export async function getSettings(): Promise<Settings> {
  return {
    systemPrompt: dbGetSetting("systemPrompt") ?? "",
    defaultSystemPrompt: DEFAULT_SYSTEM_PROMPT,
    workspaceRoot: config.workspaceRoot,
  };
}

export async function saveSettings(settings: { systemPrompt: string }): Promise<void> {
  dbSetSetting("systemPrompt", settings.systemPrompt);
}

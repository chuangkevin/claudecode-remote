import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface Settings {
  systemPrompt: string;
}

const SETTINGS_PATH = join(homedir(), ".claude", "claudecode-remote.json");

const defaults: Settings = { systemPrompt: "" };

export async function getSettings(): Promise<Settings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    return { ...defaults, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...defaults };
  }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await writeFile(SETTINGS_PATH, JSON.stringify(settings, null, 2), "utf8");
}

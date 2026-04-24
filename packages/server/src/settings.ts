import { dbGetSetting, dbSetSetting } from "./db.js";

export interface Settings {
  systemPrompt: string;
}

export async function getSettings(): Promise<Settings> {
  return { systemPrompt: dbGetSetting("systemPrompt") ?? "" };
}

export async function saveSettings(settings: Settings): Promise<void> {
  dbSetSetting("systemPrompt", settings.systemPrompt);
}

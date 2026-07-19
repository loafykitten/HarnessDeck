import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const CLAUDE_MD_PATH = join(homedir(), ".claude", "CLAUDE.md");
const APP_CONFIG_PATH = join(homedir(), ".config", "claude-command", "config.json");

export interface AppConfig {
  displayName: string;
  zip: string;          // US zip for weather; empty = no weather
  greetingEnabled: boolean;
  renewalDay: number | null; // day-of-month the subscription renews (from
                             // claude.ai billing — the API only exposes the
                             // original subscription date, which goes stale)
}

const DEFAULT_APP_CONFIG: AppConfig = {
  displayName: "",
  zip: "",
  greetingEnabled: true,
  renewalDay: null,
};

export async function getAppConfig(): Promise<AppConfig> {
  try {
    return { ...DEFAULT_APP_CONFIG, ...(await Bun.file(APP_CONFIG_PATH).json()) };
  } catch {
    return { ...DEFAULT_APP_CONFIG };
  }
}

export async function setAppConfig(patch: Partial<AppConfig>): Promise<AppConfig> {
  const next = { ...(await getAppConfig()), ...patch };
  await mkdir(dirname(APP_CONFIG_PATH), { recursive: true });
  await Bun.write(APP_CONFIG_PATH, JSON.stringify(next, null, 2) + "\n");
  return next;
}

export async function readSettings(): Promise<string> {
  return Bun.file(SETTINGS_PATH).text();
}

export async function writeSettings(text: string): Promise<void> {
  JSON.parse(text); // validate before touching disk
  await Bun.write(SETTINGS_PATH, text);
}

export async function readClaudeMd(): Promise<string> {
  try { return await Bun.file(CLAUDE_MD_PATH).text(); } catch { return ""; }
}

export async function writeClaudeMd(text: string): Promise<void> {
  await Bun.write(CLAUDE_MD_PATH, text);
}

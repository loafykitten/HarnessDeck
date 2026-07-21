import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { HARNESSES, type HarnessId } from "./harnesses";

const APP_CONFIG_PATH = join(homedir(), ".config", "harnessdeck", "config.json");
// pre-rename location (Claude Command era) — read-only fallback
const LEGACY_APP_CONFIG_PATH = join(homedir(), ".config", "claude-command", "config.json");

export interface AppConfig {
  displayName: string;
  zip: string;          // US zip for weather; empty = no weather
  greetingEnabled: boolean;
  renewalDay: number | null; // day-of-month the subscription renews (from
                             // claude.ai billing — the API only exposes the
                             // original subscription date, which goes stale)
  pet: "biblical" | "cybercat" | "foxtrix"; // site icon + favicon + the
                                            // traveler under the terminal
}

const DEFAULT_APP_CONFIG: AppConfig = {
  displayName: "",
  zip: "",
  greetingEnabled: true,
  renewalDay: null,
  pet: "biblical",
};

export async function getAppConfig(): Promise<AppConfig> {
  try {
    return { ...DEFAULT_APP_CONFIG, ...(await Bun.file(APP_CONFIG_PATH).json()) };
  } catch { /* fall through to the pre-rename path */ }
  try {
    return { ...DEFAULT_APP_CONFIG, ...(await Bun.file(LEGACY_APP_CONFIG_PATH).json()) };
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

export async function readSettings(harness: HarnessId): Promise<string> {
  try { return await Bun.file(HARNESSES[harness].settingsPath).text(); } catch { return ""; }
}

export async function writeSettings(harness: HarnessId, text: string): Promise<void> {
  const h = HARNESSES[harness];
  if (h.settingsFormat === "json") {
    JSON.parse(text); // validate before touching disk
  } else if (h.settingsFormat === "toml") {
    // Bun ships a TOML parser; validate when present, pass through otherwise
    const toml = (Bun as unknown as { TOML?: { parse(t: string): unknown } }).TOML;
    toml?.parse(text);
  }
  await Bun.write(h.settingsPath, text);
}

export async function readMd(harness: HarnessId): Promise<string> {
  try { return await Bun.file(HARNESSES[harness].mdPath).text(); } catch { return ""; }
}

export async function writeMd(harness: HarnessId, text: string): Promise<void> {
  await Bun.write(HARNESSES[harness].mdPath, text);
}

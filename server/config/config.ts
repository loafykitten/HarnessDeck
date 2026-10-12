import { join } from "node:path";
import { HARNESSES, type HarnessId } from "../harness/registry";
import { LEGACY_STATE_DIR, STATE_DIR } from "../paths";
import { readJson, writeJsonAtomic } from "../store";

const APP_CONFIG_PATH = join(STATE_DIR, "config.json");

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
  const stored = await readJson(APP_CONFIG_PATH, join(LEGACY_STATE_DIR, "config.json"));
  return { ...DEFAULT_APP_CONFIG, ...(stored && typeof stored === "object" ? stored : {}) };
}

export async function setAppConfig(patch: Partial<AppConfig>): Promise<{ previous: AppConfig; next: AppConfig }> {
  const previous = await getAppConfig();
  const next = { ...previous, ...patch };
  await writeJsonAtomic(APP_CONFIG_PATH, next, 2);
  return { previous, next };
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

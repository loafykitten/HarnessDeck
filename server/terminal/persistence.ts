import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isHarnessId, type HarnessId } from "../harness/registry";

const SESSION_REGISTRY_PATH = process.env.HARNESSDECK_SESSIONS_PATH
  ?? join(homedir(), ".config", "harnessdeck", "sessions.json");

export interface PersistedSession {
  id: string;
  project: string;
  name: string;
  harness: HarnessId;
  created: number;
}

function isPersistedSession(value: unknown): value is PersistedSession {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string"
    && typeof entry.project === "string"
    && typeof entry.name === "string"
    && isHarnessId(entry.harness)
    && typeof entry.created === "number"
    && Number.isFinite(entry.created);
}

export async function readSessionRegistry(): Promise<PersistedSession[]> {
  try {
    const value: unknown = await Bun.file(SESSION_REGISTRY_PATH).json();
    if (!Array.isArray(value)) return [];
    return value.filter(isPersistedSession);
  } catch {
    return [];
  }
}

async function writeSessionRegistry(entries: PersistedSession[]): Promise<void> {
  await mkdir(dirname(SESSION_REGISTRY_PATH), { recursive: true });
  await Bun.write(SESSION_REGISTRY_PATH, JSON.stringify(entries, null, 2) + "\n");
}

let mutationQueue: Promise<void> = Promise.resolve();

function mutateSessionRegistry(
  mutate: (entries: PersistedSession[]) => PersistedSession[],
): Promise<void> {
  const pending = mutationQueue.then(async () => {
    const previous = await readSessionRegistry();
    const next = mutate(previous);
    if (next === previous) return;
    await writeSessionRegistry(next);
  });
  mutationQueue = pending.catch(() => {});
  return pending;
}

export function addSessionRegistryEntry(entry: PersistedSession): Promise<void> {
  return mutateSessionRegistry(entries => [
    ...entries.filter(existing => existing.id !== entry.id),
    entry,
  ]);
}

export function removeSessionRegistryEntries(ids: Iterable<string>): Promise<void> {
  const removed = new Set(ids);
  if (removed.size === 0) return Promise.resolve();
  return mutateSessionRegistry(entries => {
    const next = entries.filter(entry => !removed.has(entry.id));
    return next.length === entries.length ? entries : next;
  });
}

/** Two-way sync: drop entries whose tmux session is gone (unless protected),
    and backfill live sessions missing from the registry — so sessions created
    before this feature existed (or restored by hand) still survive reboots. */
export function syncSessionRegistry(
  live: readonly PersistedSession[],
  protectedIds: ReadonlySet<string> = new Set(),
): Promise<void> {
  const liveIds = new Set(live.map(entry => entry.id));
  return mutateSessionRegistry(entries => {
    const kept = entries.filter(entry => liveIds.has(entry.id) || protectedIds.has(entry.id));
    const known = new Set(kept.map(entry => entry.id));
    const added = live.filter(entry => !known.has(entry.id));
    return added.length === 0 && kept.length === entries.length ? entries : [...kept, ...added];
  });
}

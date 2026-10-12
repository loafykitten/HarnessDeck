import { join } from "node:path";
import { isHarnessId, type HarnessId } from "../harness/registry";
import { STATE_DIR } from "../paths";
import { readJson, serialQueue, writeJsonAtomic } from "../store";

const SESSION_REGISTRY_PATH = process.env.HARNESSDECK_SESSIONS_PATH ?? join(STATE_DIR, "sessions.json");

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
  const value = await readJson(SESSION_REGISTRY_PATH);
  return Array.isArray(value) ? value.filter(isPersistedSession) : [];
}

const mutations = serialQueue();

function mutateSessionRegistry(
  mutate: (entries: PersistedSession[]) => PersistedSession[],
): Promise<void> {
  return mutations(async () => {
    const previous = await readSessionRegistry();
    const next = mutate(previous);
    if (next === previous) return;
    await writeJsonAtomic(SESSION_REGISTRY_PATH, next, 2);
  });
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

import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import type { NewsItem } from "./types";

const STATE_PATH = join(homedir(), ".config", "harnessdeck", "news.json");
export const MAX_ITEMS = 40; // stored; payload trims further
// must comfortably exceed the sitemap seed volume (~260 URLs today) plus
// months of feed ids — evicted seeds would resurface as "new" stories
const MAX_SEEN = 5000;

export interface NewsState {
  seen: string[];
  items: NewsItem[]; // synthesized items, newest first (status items live in memory)
  updatedAt: number | null;
}

let state: NewsState | null = null;

export async function ensureLoaded(): Promise<NewsState> {
  if (state) return state;
  try {
    const raw = await Bun.file(STATE_PATH).json();
    state = { seen: raw.seen ?? [], items: raw.items ?? [], updatedAt: raw.updatedAt ?? null };
  } catch {
    state = { seen: [], items: [], updatedAt: null };
  }
  return state;
}

export async function save(): Promise<void> {
  if (!state) return;
  await mkdir(dirname(STATE_PATH), { recursive: true });
  await Bun.write(STATE_PATH, JSON.stringify(state) + "\n");
}

/* The feeds and slow tiers run concurrently but share NewsState; serializing
   their read-modify-write sections is what makes the dedup sound. */
let stateQueue: Promise<unknown> = Promise.resolve();
export function locked<T>(fn: () => Promise<T>): Promise<T> {
  const p = stateQueue.then(fn, fn);
  stateQueue = p.catch(() => {});
  return p;
}

/* Sitemap/watch seeds must survive eviction — a dropped seed makes an archive
   page look brand-new on the next poll. Only non-seed ids age out. */
export function mergeSeen(a: Iterable<string>, b: Iterable<string>): string[] {
  const all = [...new Set([...a, ...b])];
  if (all.length <= MAX_SEEN) return all;
  const isSeed = (id: string) => id.startsWith("sm:") || id.startsWith("smh:");
  const seeds = all.filter(isSeed);
  const rest = all.filter(id => !isSeed(id));
  return [...seeds, ...rest.slice(-Math.max(0, MAX_SEEN - seeds.length))];
}

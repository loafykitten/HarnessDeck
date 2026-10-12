import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/** The first of `paths` that holds valid JSON, or null. Later paths are
    fallbacks — typically a pre-rename location still read for old installs. */
export async function readJson(...paths: string[]): Promise<unknown> {
  for (const path of paths) {
    try { return await Bun.file(path).json(); } catch { /* missing or torn — try the next */ }
  }
  return null;
}

let tmpCounter = 0;

/** Write through a temp file + rename, so a crash or a concurrent reader
    never sees a half-written file. The temp name is unique per call: two
    unserialized writes to the same path must not share one. */
export async function writeJsonAtomic(path: string, value: unknown, space?: number): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}-${++tmpCounter}`;
  try {
    await writeFile(tmp, JSON.stringify(value, null, space) + "\n");
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => {});
    throw error;
  }
}

/** Runs async sections one at a time, in call order — for read-modify-write
    cycles on shared state. A failed section rejects its own caller but never
    blocks the sections queued behind it. */
export function serialQueue(): <T>(section: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return section => {
    const result = tail.then(section);
    tail = result.catch(() => {});
    return result;
  };
}

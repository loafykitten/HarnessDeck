import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/** Every location outside the repo the server reads or writes, in one place. */

export const HOME = homedir();

/** Projects are the direct child directories of this. */
export const DEV_DIR = join(HOME, "Developer");

/** Durable app state: config, session registries, last-good API caches. */
export const STATE_DIR = join(HOME, ".config", "harnessdeck");
/** Pre-rename (Claude Command era) state dir — read-only fallback. */
export const LEGACY_STATE_DIR = join(HOME, ".config", "claude-command");

/** Pasted images are disposable, so they live under Caches, not STATE_DIR. */
export const PASTE_DIR = join(HOME, "Library", "Caches", "HarnessDeck", "pastes");

export const CLAUDE_HOME = join(HOME, ".claude");
export const CODEX_HOME = join(HOME, ".codex");

/** Claude Code keeps a project's transcripts under a slug of its path: every
    non-alphanumeric character becomes '-' (matched against the CLI's own
    implementation — '_' and spaces are replaced too, not just '/' and '.'). */
export function claudeTranscriptDir(cwd: string): string {
  return join(CLAUDE_HOME, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"));
}

export const CODEX_SESSIONS_DIR = join(CODEX_HOME, "sessions");

/** Codex rollout files, newest first: sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl.
    Both the date dirs and the timestamped names sort lexicographically, so a
    reverse walk yields them in creation order without statting anything —
    and callers that only want the first few never touch older days. */
export async function* codexRolloutFiles(): AsyncGenerator<string> {
  const newestFirst = async (dir: string, keep: (entry: { name: string; isDirectory(): boolean }) => boolean) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter(keep)
      .map(entry => entry.name)
      .sort()
      .reverse();
  const isDir = (entry: { isDirectory(): boolean }) => entry.isDirectory();
  for (const year of await newestFirst(CODEX_SESSIONS_DIR, isDir)) {
    for (const month of await newestFirst(join(CODEX_SESSIONS_DIR, year), isDir)) {
      for (const day of await newestFirst(join(CODEX_SESSIONS_DIR, year, month), isDir)) {
        const dayDir = join(CODEX_SESSIONS_DIR, year, month, day);
        for (const name of await newestFirst(dayDir, entry => entry.name.endsWith(".jsonl"))) {
          yield join(dayDir, name);
        }
      }
    }
  }
}

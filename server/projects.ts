import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_DIR, listSessions } from "./sessions";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

export interface Project {
  name: string;
  dir: string;
  lastActivity: number | null; // ms epoch, from Claude Code transcript mtimes
  sessions: { id: string; name: string; activity: number; harness: string }[];
}

/** Claude Code's transcript dir slug: path with '/' and '.' replaced by '-'. */
function transcriptSlug(dir: string): string {
  return dir.replace(/[/.]/g, "-");
}

export async function listProjects(): Promise<Project[]> {
  let entries;
  try {
    entries = await readdir(DEV_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = await listSessions();
  const projects: Project[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const dir = join(DEV_DIR, e.name);
    let lastActivity: number | null = null;
    try {
      const tdir = join(CLAUDE_PROJECTS, transcriptSlug(dir));
      for (const f of await readdir(tdir)) {
        if (!f.endsWith(".jsonl")) continue;
        const s = await stat(join(tdir, f));
        if (lastActivity === null || s.mtimeMs > lastActivity) lastActivity = s.mtimeMs;
      }
    } catch { /* never touched by claude — fine */ }
    const running = sessions
      .filter(s => s.project === e.name)
      .map(s => ({ id: s.id, name: s.name, activity: s.activity, harness: s.harness }));
    // Claude transcripts aren't the only signal: a live session of any
    // harness (codex has no transcript dir we read) counts as activity too
    for (const s of running) {
      if (lastActivity === null || s.activity > lastActivity) lastActivity = s.activity;
    }
    projects.push({ name: e.name, dir, lastActivity, sessions: running });
  }
  projects.sort((a, b) =>
    (b.sessions.length - a.sessions.length) ||
    ((b.lastActivity ?? 0) - (a.lastActivity ?? 0)));
  return projects;
}

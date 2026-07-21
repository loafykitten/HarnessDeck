import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_DIR, listSessionsBase } from "../terminal/sessions";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");

export interface Project {
  name: string;
  dir: string;
  lastActivity: number | null; // ms epoch, from Claude Code transcript mtimes
  sessions: { id: string; name: string; activity: number; harness: string }[];
  git?: {
    branch: string;
    ahead: number | null;
    dirty: number;
    branches: string[];
    worktrees: { branch: string; path: string }[];
  } | null;
}

/** Claude Code's transcript dir slug: path with '/' and '.' replaced by '-'. */
function transcriptSlug(dir: string): string {
  return dir.replace(/[/.]/g, "-");
}

async function git(dir: string, ...args: string[]): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    const [out, , code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return code === 0 ? out.trim() : null;
  } catch {
    return null;
  }
}

// the dashboard polls /api/projects every 5s; don't fork 6 git processes per
// project per poll — git state moves slowly, serve it from a short-lived cache
const GIT_TTL = 30_000;
const gitCache = new Map<string, { at: number; info: Project["git"] }>();
const gitRefreshes = new Map<string, Promise<Project["git"]>>();

function refreshProjectGit(dir: string): Promise<Project["git"]> {
  const active = gitRefreshes.get(dir);
  if (active) return active;
  const refresh = projectGit(dir).then(info => {
    gitCache.set(dir, { at: Date.now(), info });
    return info;
  });
  gitRefreshes.set(dir, refresh);
  const clear = () => { if (gitRefreshes.get(dir) === refresh) gitRefreshes.delete(dir); };
  refresh.then(clear, clear);
  return refresh;
}

async function projectGitCached(dir: string): Promise<Project["git"]> {
  const hit = gitCache.get(dir);
  if (hit && Date.now() - hit.at < GIT_TTL) return hit.info;
  if (hit) {
    void refreshProjectGit(dir).catch(() => {});
    return hit.info;
  }
  return refreshProjectGit(dir);
}

async function projectGit(dir: string): Promise<Project["git"]> {
  if (await git(dir, "rev-parse", "--is-inside-work-tree") !== "true") return null;
  const [branchOut, aheadOut, statusOut, branchesOut, worktreesOut] = await Promise.all([
    git(dir, "branch", "--show-current"),
    git(dir, "rev-list", "--count", "@{upstream}..HEAD"),
    git(dir, "status", "--porcelain"),
    git(dir, "for-each-ref", "--format=%(refname:short)", "refs/heads"),
    git(dir, "worktree", "list", "--porcelain"),
  ]);
  if (branchOut === null || statusOut === null || branchesOut === null || worktreesOut === null) return null;

  const worktrees = worktreesOut.split(/\n\n+/).slice(1).flatMap(block => {
    const lines = block.split("\n");
    const path = lines.find(line => line.startsWith("worktree "))?.slice(9);
    if (!path) return [];
    const ref = lines.find(line => line.startsWith("branch "))?.slice(7);
    return [{ branch: ref?.replace(/^refs\/heads\//, "") ?? "detached", path }];
  });

  return {
    branch: branchOut || "HEAD",
    ahead: aheadOut !== null && /^\d+$/.test(aheadOut) ? Number(aheadOut) : null,
    dirty: statusOut ? statusOut.split("\n").length : 0,
    branches: branchesOut ? branchesOut.split("\n").filter(name =>
      name !== "main" && name !== "master" && name !== branchOut) : [],
    worktrees,
  };
}

const TRANSCRIPT_TTL = 30_000;
const transcriptCache = new Map<string, { at: number; lastActivity: number | null }>();

async function transcriptActivityCached(dir: string): Promise<number | null> {
  const hit = transcriptCache.get(dir);
  if (hit && Date.now() - hit.at < TRANSCRIPT_TTL) return hit.lastActivity;
  let lastActivity: number | null = null;
  try {
    const tdir = join(CLAUDE_PROJECTS, transcriptSlug(dir));
    const files = (await readdir(tdir)).filter(f => f.endsWith(".jsonl"));
    const stats = await Promise.all(files.map(f => stat(join(tdir, f)).catch(() => null)));
    for (const s of stats) {
      if (!s) continue;
      if (lastActivity === null || s.mtimeMs > lastActivity) lastActivity = s.mtimeMs;
    }
  } catch { /* never touched by claude — fine */ }
  transcriptCache.set(dir, { at: Date.now(), lastActivity });
  return lastActivity;
}

export async function listProjects(): Promise<Project[]> {
  let entries;
  try {
    entries = await readdir(DEV_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const sessions = await listSessionsBase();
  const projects = await Promise.all(entries
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(async e => {
      const dir = join(DEV_DIR, e.name);
      const gitInfo = projectGitCached(dir);
      let lastActivity = await transcriptActivityCached(dir);
      const running = sessions
        .filter(s => s.project === e.name)
        .map(s => ({ id: s.id, name: s.name, activity: s.activity, harness: s.harness }));
      // Claude transcripts aren't the only signal: a live session of any
      // harness (codex has no transcript dir we read) counts as activity too
      for (const s of running) {
        if (lastActivity === null || s.activity > lastActivity) lastActivity = s.activity;
      }
      return { name: e.name, dir, lastActivity, sessions: running, git: await gitInfo };
    }));
  projects.sort((a, b) =>
    (b.sessions.length - a.sessions.length) ||
    ((b.lastActivity ?? 0) - (a.lastActivity ?? 0)));
  return projects;
}

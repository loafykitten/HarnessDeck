import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { beginShutdown, busyChatSessions } from "./chat/sessions";
import { err, json, type RouteHandler } from "./http";

/* The server knows when the code on disk has moved past what this process
   booted with, and can restart itself deliberately: launchd's KeepAlive
   respawns the process after a clean exit. Restarting severs live chat turns,
   so the endpoint refuses while chats are working unless forced. */

const REPO_ROOT = join(import.meta.dir, "..");
const BOOTED_AT = Date.now();

/** Changes outside these paths (web/, docs/) don't need a server restart. */
const RESTART_PATHS = ["server/", "package.json", "bun.lock"];

async function git(...args: string[]): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd: REPO_ROOT, stdout: "pipe", stderr: "ignore" });
  const output = await new Response(proc.stdout).text();
  return (await proc.exited) === 0 ? output.trim() : null;
}

const bootedCommit = await git("rev-parse", "HEAD");

/* The web bundle is a build artifact: commits can land in web/ without anyone
   running `bun run build`, and the site silently keeps serving yesterday's UI
   (this happened — the subagent drill-in shipped in git but not in dist).
   Staleness is measured by mtime, not commits, so uncommitted edits count too:
   any source file newer than dist/index.html means the bundle is behind. */

const WEB_DIR = join(REPO_ROOT, "web");
const DIST_STAMP = join(WEB_DIR, "dist", "index.html");
/** Inputs to the build; everything else under web/ is output or lockfiles. */
const WEB_SOURCE_ROOTS = ["src", "public", "index.html", "vite.config.ts", "svelte.config.js", "package.json"];

async function* walk(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.name.startsWith(".")) continue; // .DS_Store and friends aren't build inputs
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

async function webBuildState(): Promise<{ builtAt: number | null; stale: string[] }> {
  const builtAt = await stat(DIST_STAMP).then(s => s.mtimeMs, () => null);
  const stale: string[] = [];
  const consider = (path: string, mtime: number) => {
    if (builtAt === null || mtime > builtAt) stale.push(relative(REPO_ROOT, path));
  };
  for (const root of WEB_SOURCE_ROOTS) {
    const rootPath = join(WEB_DIR, root);
    const info = await stat(rootPath).catch(() => null);
    if (!info) continue;
    if (!info.isDirectory()) { consider(rootPath, info.mtimeMs); continue; }
    for await (const path of walk(rootPath)) {
      const entry = await stat(path).catch(() => null);
      if (entry) consider(path, entry.mtimeMs);
    }
  }
  return { builtAt, stale: stale.sort() };
}

/** One build at a time; concurrent requests join the run already in flight. */
let webBuild: Promise<{ ok: boolean; output: string }> | null = null;

function runWebBuild(): Promise<{ ok: boolean; output: string }> {
  webBuild ??= (async () => {
    try {
      const proc = Bun.spawn(["bun", "run", "build:web"], {
        cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
      });
      const [output, errors, code] = await Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      return { ok: code === 0, output: (output + errors).slice(-4000) };
    } finally {
      webBuild = null;
    }
  })();
  return webBuild;
}

/** Browser-reachable state-changing POSTs share restart's CSRF posture: a JSON
    content-type forces a preflight this server never answers, and the Origin
    check backstops it. */
function guardBrowserPost(req: Request, url: URL): Response | null {
  if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
    return err("requires a JSON body", 415);
  }
  const origin = req.headers.get("origin");
  if (origin && URL.parse(origin)?.host !== url.host) {
    return err("cross-origin request rejected", 403);
  }
  return null;
}

/* The project this server's code belongs to: the main checkout, even when the
   process was booted from a linked worktree (drift is still measured against
   the booted worktree's own HEAD). */
const commonGitDir = await git("rev-parse", "--path-format=absolute", "--git-common-dir");
const PROJECT_DIR = commonGitDir?.endsWith("/.git") ? commonGitDir.slice(0, -"/.git".length) : REPO_ROOT;

export const restartRoutes: RouteHandler = async (req, url) => {
  if (url.pathname === "/api/server/status" && req.method === "GET") {
    const headCommit = await git("rev-parse", "HEAD");
    const moved = bootedCommit !== null && headCommit !== null && headCommit !== bootedCommit;
    const pendingFiles = moved
      ? (await git("diff", "--name-only", `${bootedCommit}..${headCommit}`, "--", ...RESTART_PATHS))
        ?.split("\n").filter(Boolean) ?? []
      : [];
    const commitsBehind = moved
      ? Number(await git("rev-list", "--count", `${bootedCommit}..${headCommit}`)) || 0
      : 0;
    return json({
      dir: PROJECT_DIR,
      bootedAt: BOOTED_AT,
      bootedCommit,
      headCommit,
      commitsBehind,
      pendingFiles,
      web: await webBuildState(),
      busyChats: await busyChatSessions(),
    });
  }
  if (url.pathname === "/api/server/rebuild-web" && req.method === "POST") {
    const guarded = guardBrowserPost(req, url);
    if (guarded) return guarded;
    const result = await runWebBuild();
    if (!result.ok) return json({ error: "web build failed", output: result.output }, 500);
    return json({ ok: true, web: await webBuildState() });
  }
  if (url.pathname === "/api/server/restart" && req.method === "POST") {
    // A restart is a state-changing action reachable from the user's browser
    // (loopback + tailnet): refuse the no-preflight cross-origin shapes.
    const guarded = guardBrowserPost(req, url);
    if (guarded) return guarded;
    const body = await req.json().catch(() => null) as { force?: boolean; acknowledged?: string[] } | null;
    const acknowledged = new Set(Array.isArray(body?.acknowledged) ? body.acknowledged : []);
    const busy = await busyChatSessions();
    // Every currently-busy chat must have been named in the confirmation the
    // user accepted; a chat that went busy since then 409s instead of being
    // silently severed. `force` remains the blanket escape hatch.
    const unacknowledged = busy.filter(session => !acknowledged.has(session.id));
    if (unacknowledged.length > 0 && body?.force !== true) {
      return err(`${unacknowledged.length} chat session${unacknowledged.length === 1 ? " is" : "s are"} mid-turn`, 409);
    }
    beginShutdown();
    setTimeout(() => process.exit(0), 250);
    return json({ restarting: true });
  }
  return null;
};

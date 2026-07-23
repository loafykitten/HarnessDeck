import { join } from "node:path";
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
      busyChats: await busyChatSessions(),
    });
  }
  if (url.pathname === "/api/server/restart" && req.method === "POST") {
    // A restart is a state-changing action reachable from the user's browser
    // (loopback + tailnet): refuse the no-preflight cross-origin shapes.
    // Requiring a JSON content-type forces a CORS preflight, which fails here
    // because this server never answers one; the Origin check backstops it.
    if (!(req.headers.get("content-type") ?? "").includes("application/json")) {
      return err("restart requires a JSON body", 415);
    }
    const origin = req.headers.get("origin");
    if (origin && URL.parse(origin)?.host !== url.host) {
      return err("cross-origin restart rejected", 403);
    }
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

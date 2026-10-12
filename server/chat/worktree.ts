import { basename, isAbsolute, join } from "node:path";
import { appendFile, mkdir, readFile, realpath, stat } from "node:fs/promises";

/* Opt-in per-chat git worktrees. An isolated chat gets a fresh checkout at
   <project>/.worktrees/worktree-<slug> on a branch of the same name, so the
   agent can't trample the main working tree or other chats. Living inside the
   project keeps the codex sandbox (writableRoots = [cwd]) and the shared .git
   both reachable. */

const WORKTREES_DIR = ".worktrees";

async function git(cwd: string, ...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  try {
    const p = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    return { ok: code === 0, out: out.trim(), err: err.trim() };
  } catch (error) {
    return { ok: false, out: "", err: error instanceof Error ? error.message : String(error) };
  }
}

/** Chat titles are free text; branch and directory names are not. Length is
    capped so ref lock filenames stay well under filesystem limits, and the
    trim/.lock passes iterate until stable so no order of operations can
    re-expose an invalid suffix. Mirrored by the preview in Chat.svelte. */
export function worktreeSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
  for (let prev = ""; prev !== slug; ) {
    prev = slug;
    slug = slug.replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, "");
  }
  return slug || "chat";
}

/** Hide the nested checkouts from git status without dirtying the tracked
    .gitignore — .git/info/exclude is local-only. */
async function ensureExcluded(projectDir: string): Promise<void> {
  const common = await git(projectDir, "rev-parse", "--git-common-dir");
  if (!common.ok) return;
  const gitDir = isAbsolute(common.out) ? common.out : join(projectDir, common.out);
  const excludePath = join(gitDir, "info", "exclude");
  const line = `${WORKTREES_DIR}/`;
  try {
    const existing = await readFile(excludePath, "utf8").catch(() => "");
    if (existing.split("\n").some(entry => entry.trim() === line)) return;
    await mkdir(join(gitDir, "info"), { recursive: true });
    await appendFile(excludePath, `${existing && !existing.endsWith("\n") ? "\n" : ""}${line}\n`);
  } catch (error) {
    console.error("chat worktree: exclude entry", error);
  }
}

/** Create a worktree + branch for a chat; returns the project-relative path,
    e.g. ".worktrees/worktree-fix-auth". Collisions get a numeric suffix. */
export async function createChatWorktree(projectDir: string, chatName: string): Promise<string> {
  // The project itself must be the repo root — merely sitting inside some
  // enclosing repo would silently create a worktree of the parent.
  const top = await git(projectDir, "rev-parse", "--show-toplevel");
  const [realTop, realProject] = await Promise.all([
    top.ok ? realpath(top.out).catch(() => null) : null,
    realpath(projectDir).catch(() => null),
  ]);
  if (!realTop || !realProject || realTop !== realProject) {
    throw new Error("worktree requested but the project is not a git repository");
  }
  await ensureExcluded(projectDir);
  // Creating the worktree while .worktrees/ isn't ignored would dirty the very
  // checkout this feature exists to protect. check-ignore also passes when the
  // repo's own .gitignore already covers it. The trailing slash matters: on a
  // first run the directory doesn't exist yet, and without it git can't match
  // a directory-only pattern like ".worktrees/".
  const ignored = await git(projectDir, "check-ignore", "-q", `${WORKTREES_DIR}/`);
  if (!ignored.ok) {
    throw new Error("could not exclude .worktrees/ from git status — is .git/info/exclude writable?");
  }
  const base = `worktree-${worktreeSlug(chatName)}`;
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = attempt === 0 ? base : `${base}-${attempt + 1}`;
    const rel = join(WORKTREES_DIR, name);
    const dirTaken = await stat(join(projectDir, rel)).then(() => true, () => false);
    const branchTaken = (await git(projectDir, "rev-parse", "--verify", "--quiet", `refs/heads/${name}`)).ok;
    if (dirTaken || branchTaken) continue;
    const added = await git(projectDir, "worktree", "add", "-b", name, rel);
    if (added.ok) return rel;
    // A concurrent create can win the name between our check and the add;
    // collision-shaped failures just try the next suffix.
    if (/already exists|already registered|already checked out/i.test(added.err)) continue;
    throw new Error(`git worktree add failed: ${added.err || added.out}`);
  }
  throw new Error(`could not find a free worktree name for ${base}`);
}

/** Best-effort cleanup on chat deletion: remove the worktree (and branch) only
    when nothing would be lost — no uncommitted changes and no commits that
    aren't already reachable from the project's HEAD. Otherwise the checkout
    stays behind for manual triage. */
export async function removeChatWorktree(projectDir: string, rel: string): Promise<"removed" | "kept"> {
  const branch = basename(rel);
  const dir = join(projectDir, rel);
  const exists = await stat(dir).then(info => info.isDirectory(), () => false);
  if (!exists) {
    // Directory vanished out-of-band; tidy git's bookkeeping and the branch.
    await git(projectDir, "worktree", "prune");
    await git(projectDir, "branch", "-d", branch);
    return "removed";
  }
  // Ignored files are deliberately treated as disposable — they're what the
  // repo's own .gitignore declares regenerable (node_modules, dist, …), and
  // requiring a pristine tree would keep every worktree an agent built in.
  const status = await git(dir, "status", "--porcelain");
  if (!status.ok || status.out !== "") return "kept";
  // Check the commit actually checked out, not the branch we created: an agent
  // may have switched branches or committed on a detached HEAD.
  const head = await git(dir, "rev-parse", "HEAD");
  if (!head.ok) return "kept";
  const merged = await git(projectDir, "merge-base", "--is-ancestor", head.out, "HEAD");
  if (!merged.ok) return "kept";
  const removed = await git(projectDir, "worktree", "remove", rel);
  if (!removed.ok) return "kept";
  await git(projectDir, "branch", "-d", branch);
  return "removed";
}

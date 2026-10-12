import { lstat, mkdir, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { INSTALL_DIR, parseFrontmatter, run, sanitizeName } from "./skills";

const MAX_ZIP_BYTES = 200 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 120_000;
// skills are a few text files; these only exist to stop a zip bomb
const MAX_UNZIPPED_BYTES = 500 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const UNZIP_TIMEOUT_MS = 60_000;
const EXTRACT_POLL_MS = 200;

/** Stream the body to disk, counting bytes as they arrive: Content-Length
    is advisory and absent on chunked responses, so it can't be the limit. */
async function downloadCapped(res: Response, dest: string): Promise<boolean> {
  const writer = Bun.file(dest).writer();
  let total = 0;
  try {
    for await (const chunk of res.body!) {
      total += chunk.byteLength;
      if (total > MAX_ZIP_BYTES) return false; // leaving the loop cancels the body
      writer.write(chunk);
    }
    return true;
  } finally {
    await writer.end();
  }
}

/** Reject archives whose central directory declares too much before any of
    it hits the disk. Only a cheap first pass: the sizes are whatever the
    archive claims, so extractCapped enforces the budget on real bytes. */
async function zipWithinLimits(zipPath: string): Promise<boolean> {
  const info = await run(["zipinfo", "-t", zipPath], { timeoutMs: 30_000 });
  const m = info.out.match(/(\d+) files?, (\d+) bytes uncompressed/);
  return !!m && Number(m[1]) <= MAX_ZIP_ENTRIES && Number(m[2]) <= MAX_UNZIPPED_BYTES;
}

/** Bytes and entries under dir. lstat, so links count as themselves. */
async function treeUsage(dir: string): Promise<{ bytes: number; entries: number }> {
  let bytes = 0;
  let entries = 0;
  async function walk(d: string) {
    // unzip is still writing; entries can appear or vanish mid-walk
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      entries++;
      const p = join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else bytes += (await lstat(p).catch(() => null))?.size ?? 0;
    }
  }
  await walk(dir);
  return { bytes, entries };
}

function overBudget(usage: { bytes: number; entries: number }): boolean {
  return usage.bytes > MAX_UNZIPPED_BYTES || usage.entries > MAX_ZIP_ENTRIES;
}

/** Extract with the budget enforced on what unzip actually writes, since a
    member declaring 1 byte can inflate to gigabytes. RLIMIT_FSIZE caps any
    single file (the kernel stops the write), and a watchdog totals the
    output and kills unzip once the archive as a whole goes over. `exec`
    leaves unzip as the only process, so killing the pid stops everything. */
async function extractCapped(zipPath: string, dest: string): Promise<"ok" | "too-large" | "failed"> {
  const blocks = Math.ceil(MAX_UNZIPPED_BYTES / 512); // ulimit -f counts 512-byte blocks
  const p = Bun.spawn(
    ["/bin/sh", "-c", `ulimit -f ${blocks} && exec unzip -q "$0" -d "$1"`, zipPath, dest],
    // stdin closed: unzip answers its "write error, continue?" prompt with EOF instead of hanging
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  );
  let exited = false;
  const done = p.exited.finally(() => { exited = true; });
  const deadline = Date.now() + UNZIP_TIMEOUT_MS;
  let tooLarge = false;
  while (!exited) {
    await Promise.race([done, Bun.sleep(EXTRACT_POLL_MS)]);
    if (exited) break;
    if (overBudget(await treeUsage(dest))) tooLarge = true;
    if (tooLarge || Date.now() > deadline) {
      p.kill("SIGKILL");
      break;
    }
  }
  const code = await done;
  // The per-file cap fired, or the last writes landed between two polls.
  if (tooLarge || p.signalCode === "SIGXFSZ" || overBudget(await treeUsage(dest))) return "too-large";
  return code === 0 ? "ok" : "failed";
}

/** git and unzip recreate symlinks verbatim; one pointing outside its skill
    would hand the file editor a path to anything the server can touch.
    Links that resolve inside the skill are kept. Doesn't follow links, so
    a self-referencing loop can't recurse. */
async function stripEscapingLinks(skillDir: string): Promise<void> {
  const root = await realpath(skillDir);
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isSymbolicLink()) {
        const target = await realpath(p).catch(() => null);
        if (!target || !target.startsWith(root + "/")) await rm(p, { force: true });
      } else if (e.isDirectory()) {
        await walk(p);
      }
    }
  }
  await walk(skillDir);
}

export async function installFromUrl(url: string):
  Promise<{ installed: string[]; skipped: string[] } | { error: string }> {
  if (!/^https?:\/\//.test(url)) return { error: "only http(s) URLs are supported" };
  const tmp = join(tmpdir(), `cc-skill-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    let root = tmp;
    let fallbackName = basename(new URL(url).pathname).replace(/\.(git|zip)$/, "") || "skill";
    if (/\.zip($|\?)/.test(url)) {
      // the timeout covers the body stream too, not just the headers
      const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_BYTES) {
        return { error: "download too large (200MB limit)" };
      }
      const zipPath = join(tmp, "skill.zip");
      if (!(await downloadCapped(res, zipPath))) return { error: "download too large (200MB limit)" };
      if (!(await zipWithinLimits(zipPath))) {
        return { error: "archive too large to extract (500MB / 10k files limit)" };
      }
      // A bail-out leaves partial output in tmp; the finally below removes it.
      const extracted = await extractCapped(zipPath, join(tmp, "x"));
      if (extracted === "too-large") return { error: "archive too large to extract (500MB / 10k files limit)" };
      if (extracted === "failed") return { error: "unzip failed" };
      root = join(tmp, "x");
    } else {
      const clone = await run(
        ["git", "clone", "--depth", "1", url, join(tmp, "x")],
        { timeoutMs: 120_000 },
      );
      if (!clone.ok) return { error: `git clone failed: ${clone.err.split("\n")[0]}` };
      root = join(tmp, "x");
    }

    // find every directory (≤2 deep) containing a SKILL.md
    const found: { dir: string; name: string }[] = [];
    async function scan(dir: string, depth: number) {
      if (depth > 2) return;
      const md = join(dir, "SKILL.md");
      // lstat: a SKILL.md that is itself a link would be read from wherever it points
      if ((await lstat(md).catch(() => null))?.isFile()) {
        const fm = parseFrontmatter(await Bun.file(md).text());
        const name = sanitizeName(fm.name ?? "")
          ?? sanitizeName(dir === root ? fallbackName : basename(dir))
          ?? "skill";
        found.push({ dir, name });
        return; // don't descend into a skill
      }
      for (const e of await readdir(dir, { withFileTypes: true })) {
        if (e.isDirectory() && !e.name.startsWith(".")) await scan(join(dir, e.name), depth + 1);
      }
    }
    await scan(root, 0);
    if (found.length === 0) return { error: "no SKILL.md found in that URL" };

    await mkdir(INSTALL_DIR, { recursive: true });
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const f of found) {
      const dest = join(INSTALL_DIR, f.name);
      try {
        await stat(dest);
        skipped.push(f.name); // already exists
      } catch {
        await rm(join(f.dir, ".git"), { recursive: true, force: true });
        await stripEscapingLinks(f.dir);
        await rename(f.dir, dest).catch(async () => {
          // cross-device fallback
          await run(["cp", "-R", f.dir, dest]);
        });
        installed.push(f.name);
      }
    }
    return { installed, skipped };
  } catch (e) {
    return { error: e instanceof Error ? e.message : "install failed" };
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
}

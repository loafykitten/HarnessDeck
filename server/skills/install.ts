import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { INSTALL_DIR, parseFrontmatter, run, sanitizeName } from "./skills";

const MAX_ZIP_BYTES = 200 * 1024 * 1024;

export async function installFromUrl(url: string):
  Promise<{ installed: string[]; skipped: string[] } | { error: string }> {
  if (!/^https?:\/\//.test(url)) return { error: "only http(s) URLs are supported" };
  const tmp = join(tmpdir(), `cc-skill-${Date.now()}`);
  await mkdir(tmp, { recursive: true });
  try {
    let root = tmp;
    let fallbackName = basename(new URL(url).pathname).replace(/\.(git|zip)$/, "") || "skill";
    if (/\.zip($|\?)/.test(url)) {
      const res = await fetch(url, { redirect: "follow" });
      if (!res.ok) return { error: `download failed: HTTP ${res.status}` };
      const contentLength = Number(res.headers.get("content-length"));
      if (Number.isFinite(contentLength) && contentLength > MAX_ZIP_BYTES) {
        return { error: "download too large (200MB limit)" };
      }
      const zipPath = join(tmp, "skill.zip");
      await Bun.write(zipPath, res);
      const unzip = await run(["unzip", "-q", zipPath, "-d", join(tmp, "x")], { timeoutMs: 60_000 });
      if (!unzip.ok) return { error: "unzip failed" };
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
      if (await Bun.file(md).exists()) {
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

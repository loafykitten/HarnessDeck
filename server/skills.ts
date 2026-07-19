import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join, normalize, relative } from "node:path";

const SKILLS_DIR = join(homedir(), ".claude", "skills");
const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");

const TEXT_EXT = new Set([
  ".md", ".txt", ".ts", ".js", ".json", ".yaml", ".yml", ".toml", ".sh",
  ".py", ".rb", ".swift", ".css", ".html", ".svelte", ".sql", ".xml", ".csv",
]);
const MAX_EDIT_SIZE = 256 * 1024;

// ---------- helpers ----------

function sanitizeName(name: string): string | null {
  const clean = name.trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return clean.length > 0 && clean.length <= 64 ? clean : null;
}

function skillPath(name: string): string | null {
  const clean = sanitizeName(name);
  if (!clean || clean !== name) return null;
  return join(SKILLS_DIR, name);
}

/** Resolve a relative file path inside a skill dir, refusing escapes. */
function safeFilePath(name: string, rel: string): string | null {
  const dir = skillPath(name);
  if (!dir) return null;
  const full = normalize(join(dir, rel));
  if (!full.startsWith(dir + "/") && full !== dir) return null;
  return full;
}

export function parseFrontmatter(text: string): Record<string, string> {
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return {};
  const out: Record<string, string> = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

async function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}):
  Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(cmd, { cwd: opts.cwd, stdout: "pipe", stderr: "pipe" });
  const timer = opts.timeoutMs ? setTimeout(() => p.kill(), opts.timeoutMs) : null;
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  if (timer) clearTimeout(timer);
  return { ok: code === 0, out, err };
}

// ---------- list / read / write ----------

export interface SkillSummary {
  name: string;
  description: string;
  files: number;
  updated: number;
}

export async function listSkills(): Promise<SkillSummary[]> {
  let entries;
  try {
    entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  } catch {
    return [];
  }
  const skills: SkillSummary[] = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    const md = Bun.file(join(SKILLS_DIR, e.name, "SKILL.md"));
    if (!(await md.exists())) continue;
    const fm = parseFrontmatter(await md.text());
    const files = await walkFiles(e.name);
    skills.push({
      name: e.name,
      description: fm.description ?? "",
      files: files.length,
      updated: Math.max(0, ...files.map(f => f.mtime)),
    });
  }
  skills.sort((a, b) => a.name.localeCompare(b.name));
  return skills;
}

interface SkillFile { path: string; size: number; mtime: number; editable: boolean }

async function walkFiles(name: string, sub = "", depth = 0): Promise<SkillFile[]> {
  const dir = skillPath(name);
  if (!dir || depth > 3) return [];
  const files: SkillFile[] = [];
  let entries;
  try {
    entries = await readdir(join(dir, sub), { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = sub ? join(sub, e.name) : e.name;
    if (e.isDirectory()) {
      files.push(...await walkFiles(name, rel, depth + 1));
    } else {
      const s = await stat(join(dir, rel));
      const ext = rel.slice(rel.lastIndexOf(".")).toLowerCase();
      files.push({
        path: rel,
        size: s.size,
        mtime: s.mtimeMs,
        editable: TEXT_EXT.has(ext) && s.size <= MAX_EDIT_SIZE,
      });
    }
  }
  return files;
}

export async function getSkill(name: string) {
  const dir = skillPath(name);
  if (!dir) return null;
  const md = Bun.file(join(dir, "SKILL.md"));
  if (!(await md.exists())) return null;
  const files = await walkFiles(name);
  // SKILL.md first, then alphabetical
  files.sort((a, b) =>
    (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  return { name, frontmatter: parseFrontmatter(await md.text()), files };
}

export async function readSkillFile(name: string, rel: string): Promise<string | null> {
  const full = safeFilePath(name, rel);
  if (!full) return null;
  const f = Bun.file(full);
  if (!(await f.exists())) return null;
  return f.text();
}

export async function writeSkillFile(name: string, rel: string, content: string): Promise<boolean> {
  const full = safeFilePath(name, rel);
  if (!full) return false;
  if (!(await Bun.file(full).exists())) return false; // edit-only; no file creation via this route
  await Bun.write(full, content);
  return true;
}

export async function deleteSkill(name: string): Promise<boolean> {
  const dir = skillPath(name);
  if (!dir) return false;
  if (!(await Bun.file(join(dir, "SKILL.md")).exists())) return false;
  await rm(dir, { recursive: true, force: true });
  return true;
}

// ---------- install from URL ----------

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
      const zipPath = join(tmp, "skill.zip");
      await Bun.write(zipPath, await res.blob());
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

    await mkdir(SKILLS_DIR, { recursive: true });
    const installed: string[] = [];
    const skipped: string[] = [];
    for (const f of found) {
      const dest = join(SKILLS_DIR, f.name);
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

// ---------- generate from prompt (background job) ----------

export interface SkillJob {
  id: string;
  skillName: string;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
}

const jobs = new Map<string, SkillJob>();

export function getJob(id: string): SkillJob | null {
  return jobs.get(id) ?? null;
}

export async function generateSkill(rawName: string, prompt: string):
  Promise<{ job: string } | { error: string }> {
  const name = sanitizeName(rawName);
  if (!name) return { error: "invalid skill name" };
  if (!prompt.trim()) return { error: "prompt required" };
  const dir = join(SKILLS_DIR, name);
  try {
    await stat(dir);
    return { error: `skill "${name}" already exists` };
  } catch { /* good — doesn't exist */ }
  await mkdir(dir, { recursive: true });

  const id = `job-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const job: SkillJob = { id, skillName: name, status: "running", startedAt: Date.now() };
  jobs.set(id, job);

  const fullPrompt =
    `You are scaffolding a Claude Code skill named "${name}" in the CURRENT DIRECTORY ` +
    `(which is ~/.claude/skills/${name}, already created and empty).\n\n` +
    `Create SKILL.md with YAML frontmatter containing exactly two keys:\n` +
    `- name: ${name}\n` +
    `- description: one paragraph starting with what the skill does, followed by ` +
    `when Claude should use it (trigger phrases and situations)\n\n` +
    `After the frontmatter, write the skill body: clear step-by-step instructions ` +
    `Claude will follow when the skill is invoked. Add supporting files (scripts, ` +
    `references, templates) only if they genuinely help. Keep it focused and practical.\n\n` +
    `The skill requested by the user:\n${prompt}`;

  (async () => {
    try {
      const res = await run(
        [CLAUDE_BIN, "-p", fullPrompt, "--model", "sonnet", "--output-format", "text"],
        { cwd: dir, timeoutMs: 5 * 60_000 },
      );
      const ok = res.ok && await Bun.file(join(dir, "SKILL.md")).exists();
      if (ok) {
        job.status = "done";
      } else {
        job.status = "error";
        job.error = res.ok ? "generation finished but produced no SKILL.md" : "claude -p failed";
        await rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    } catch (e) {
      job.status = "error";
      job.error = e instanceof Error ? e.message : "generation failed";
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  })();

  return { job: id };
}

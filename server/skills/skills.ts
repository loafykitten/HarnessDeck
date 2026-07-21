import { mkdir, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, normalize } from "node:path";
import { DEFAULT_HARNESS, HARNESSES, HARNESS_IDS, isHarnessId, type HarnessId } from "../harness/registry";

/** Skills are identified by NAME across harnesses: ~/.claude/skills/foo and
    ~/.codex/skills/foo are the same skill "owned" by both harnesses. Reads
    come from the first owner in HARNESS_IDS order; writes go to every owner
    so shared skills never drift. */

const TEXT_EXT = new Set([
  ".md", ".txt", ".ts", ".js", ".json", ".yaml", ".yml", ".toml", ".sh",
  ".py", ".rb", ".swift", ".css", ".html", ".svelte", ".sql", ".xml", ".csv",
]);
const MAX_EDIT_SIZE = 256 * 1024;

// ---------- helpers ----------

export function sanitizeName(name: string): string | null {
  const clean = name.trim().replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  return clean.length > 0 && clean.length <= 64 ? clean : null;
}

function skillPath(harness: HarnessId, name: string): string | null {
  const clean = sanitizeName(name);
  if (!clean || clean !== name) return null;
  return join(HARNESSES[harness].skillsDir, name);
}

/** Harnesses whose skills dir contains this skill, in registry order. */
export async function skillOwners(name: string): Promise<HarnessId[]> {
  const owners: HarnessId[] = [];
  for (const h of HARNESS_IDS) {
    const dir = skillPath(h, name);
    if (dir && await Bun.file(join(dir, "SKILL.md")).exists()) owners.push(h);
  }
  return owners;
}

/** Resolve a relative file path inside a skill dir, refusing escapes. */
function safeFilePath(harness: HarnessId, name: string, rel: string): string | null {
  const dir = skillPath(harness, name);
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

export async function run(cmd: string[], opts: { cwd?: string; timeoutMs?: number } = {}):
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
  harnesses: HarnessId[];
}

export async function listSkills(): Promise<SkillSummary[]> {
  const byName = new Map<string, SkillSummary>();
  for (const h of HARNESS_IDS) {
    let entries;
    try {
      entries = await readdir(HARNESSES[h].skillsDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".")) continue;
      const md = Bun.file(join(HARNESSES[h].skillsDir, e.name, "SKILL.md"));
      if (!(await md.exists())) continue;
      const existing = byName.get(e.name);
      if (existing) {
        existing.harnesses.push(h);
        continue; // description/files come from the first owner
      }
      const fm = parseFrontmatter(await md.text());
      const files = await walkFiles(h, e.name);
      byName.set(e.name, {
        name: e.name,
        description: fm.description ?? "",
        files: files.length,
        updated: Math.max(0, ...files.map(f => f.mtime)),
        harnesses: [h],
      });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

interface SkillFile { path: string; size: number; mtime: number; editable: boolean }

async function walkFiles(harness: HarnessId, name: string, sub = "", depth = 0): Promise<SkillFile[]> {
  const dir = skillPath(harness, name);
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
      files.push(...await walkFiles(harness, name, rel, depth + 1));
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
  const owners = await skillOwners(name);
  if (owners.length === 0) return null;
  const primary = owners[0];
  const md = Bun.file(join(skillPath(primary, name)!, "SKILL.md"));
  const files = await walkFiles(primary, name);
  // SKILL.md first, then alphabetical
  files.sort((a, b) =>
    (a.path === "SKILL.md" ? -1 : b.path === "SKILL.md" ? 1 : a.path.localeCompare(b.path)));
  return { name, frontmatter: parseFrontmatter(await md.text()), files, harnesses: owners };
}

export async function readSkillFile(name: string, rel: string): Promise<string | null> {
  for (const h of await skillOwners(name)) {
    const full = safeFilePath(h, name, rel);
    if (!full) return null;
    const f = Bun.file(full);
    if (await f.exists()) return f.text();
  }
  return null;
}

/** The edit lands in EVERY owning harness — a skill owned by both claude
    and codex stays identical in both places. Edit-only at the skill level
    (at least one owner must already have the file), but an owner missing
    this particular file gets it created: diverged copies converge instead
    of staying diverged. */
export async function writeSkillFile(name: string, rel: string, content: string): Promise<boolean> {
  const owners = await skillOwners(name);
  const paths: string[] = [];
  let exists = false;
  for (const h of owners) {
    const full = safeFilePath(h, name, rel);
    if (!full) return false;
    paths.push(full);
    if (await Bun.file(full).exists()) exists = true;
  }
  if (!exists) return false; // no file creation via this route
  for (const full of paths) await Bun.write(full, content); // Bun.write mkdirs
  return true;
}

/** Removes the skill from every harness that has it. */
export async function deleteSkill(name: string): Promise<boolean> {
  const owners = await skillOwners(name);
  for (const h of owners) {
    await rm(skillPath(h, name)!, { recursive: true, force: true });
  }
  return owners.length > 0;
}

/** Copy the skill into another harness's skills dir (replacing any stale
    copy there), so both harnesses serve identical content from then on. */
export async function syncSkill(name: string, to: string): Promise<{ ok: true } | { error: string }> {
  if (!isHarnessId(to)) return { error: `unknown harness: ${to}` };
  const owners = await skillOwners(name);
  if (owners.length === 0) return { error: "no such skill" };
  const src = owners[0];
  if (src === to) return { error: `${to} already owns the source copy` };
  const srcDir = skillPath(src, name)!;
  const destDir = skillPath(to, name)!;
  await mkdir(HARNESSES[to].skillsDir, { recursive: true });
  await rm(destDir, { recursive: true, force: true });
  const res = await run(["cp", "-R", srcDir, destDir], { timeoutMs: 30_000 });
  return res.ok ? { ok: true } : { error: res.err.trim() || "copy failed" };
}

/** New skills land in the default harness's dir; use sync to share them. */
export const INSTALL_DIR = HARNESSES[DEFAULT_HARNESS].skillsDir;

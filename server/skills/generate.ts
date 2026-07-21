import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { HARNESSES } from "../harness/registry";
import { INSTALL_DIR, run, sanitizeName } from "./skills";

// ---------- generate from prompt (background job) ----------

export interface SkillJob {
  id: string;
  skillName: string;
  status: "running" | "done" | "error";
  error?: string;
  startedAt: number;
  completedAt?: number;
}

const jobs = new Map<string, SkillJob>();
const JOB_TTL = 10 * 60_000;

function pruneJobs(): void {
  const cutoff = Date.now() - JOB_TTL;
  for (const [id, job] of jobs) {
    if (job.completedAt !== undefined && job.completedAt <= cutoff) jobs.delete(id);
  }
}

export function getJob(id: string): SkillJob | null {
  pruneJobs();
  return jobs.get(id) ?? null;
}

export async function generateSkill(rawName: string, prompt: string):
  Promise<{ job: string } | { error: string }> {
  pruneJobs();
  const name = sanitizeName(rawName);
  if (!name) return { error: "invalid skill name" };
  if (!prompt.trim()) return { error: "prompt required" };
  const dir = join(INSTALL_DIR, name);
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
        [HARNESSES.claude.bin, "-p", fullPrompt, "--model", "sonnet", "--output-format", "text"],
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
    } finally {
      job.completedAt = Date.now();
    }
  })();

  return { job: id };
}

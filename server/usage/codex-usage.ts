import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MonthUsage } from "./claude";
import { CODEX_HOME } from "./codex-auth";

const SESSIONS_DIR = join(CODEX_HOME, "sessions");

// ---------- OAuth rate limits (5h / weekly windows) ----------

/** Codex records its ChatGPT rate-limit state in every token_count event it
    writes to the session rollout files — there is no public usage endpoint,
    so the freshest snapshot in ~/.codex/sessions is the source of truth.
    Snapshots only exist for OAuth-mode turns; on an API key the fields are
    null and we simply report the last OAuth-era reading with its timestamp. */
export interface CodexLimits {
  fiveHour: { pct: number | null; resetsAt: string | null };
  weekly: { pct: number | null; resetsAt: string | null };
  asOf: string | null; // when codex recorded the snapshot
}

interface Cache<T> { at: number; data: T | null }
const limitsCache: Cache<CodexLimits> = { at: 0, data: null };
const monthCache: Cache<MonthUsage> = { at: 0, data: null };
const spendCache: Cache<CodexSpend> = { at: 0, data: null };
let limitsInFlight: Promise<CodexLimits> | null = null;
let monthInFlight: Promise<MonthUsage> | null = null;
let spendInFlight: Promise<CodexSpend> | null = null;

const rolloutMemo = new Map<string, { mtimeMs: number; hasSnapshot: boolean }>();
const parsedRollouts = new Map<string, { mtimeMs: number; data: CodexLimits }>();
const ROLLOUT_TAIL_BYTES = 256 * 1024;

/** Newest-first rollout files: sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-…jsonl —
    both the date dirs and the file names sort lexicographically. */
async function newestSessionFiles(limit: number): Promise<string[]> {
  const out: string[] = [];
  const sortedDirs = async (dir: string) =>
    (await readdir(dir, { withFileTypes: true }).catch(() => []))
      .filter(e => e.isDirectory())
      .map(e => e.name)
      .sort()
      .reverse();
  for (const y of await sortedDirs(SESSIONS_DIR)) {
    for (const m of await sortedDirs(join(SESSIONS_DIR, y))) {
      for (const d of await sortedDirs(join(SESSIONS_DIR, y, m))) {
        const day = join(SESSIONS_DIR, y, m, d);
        const files = (await readdir(day).catch(() => []))
          .filter(f => f.endsWith(".jsonl"))
          .sort()
          .reverse();
        for (const f of files) {
          out.push(join(day, f));
          if (out.length >= limit) return out;
        }
      }
    }
  }
  return out;
}

const epochToIso = (sec: unknown) =>
  typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null;

async function grepSnapshotFiles(files: string[], strict = false): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const p = Bun.spawn(["grep", "-l", '"used_percent"', ...files], { stdout: "pipe", stderr: "ignore" });
  const hitPaths = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean);
  const code = await p.exited;
  if (strict && code > 1) throw new Error(`grep failed with exit code ${code}`);
  return new Set(hitPaths);
}

function parseLastSnapshot(text: string): CodexLimits | null {
  // last snapshot in the file wins
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"used_percent"')) continue;
    try {
      const j = JSON.parse(lines[i]);
      const rl = j.payload?.rate_limits;
      if (!rl?.primary && !rl?.secondary) continue;
      // assign by window length, not position: 300min = 5h, 10080min = 7d
      const windows = [rl.primary, rl.secondary].filter(Boolean);
      const five = windows.find((w: any) => w.window_minutes <= 600);
      const week = windows.find((w: any) => w.window_minutes > 600);
      return {
        fiveHour: { pct: five?.used_percent ?? null, resetsAt: epochToIso(five?.resets_at) },
        weekly: { pct: week?.used_percent ?? null, resetsAt: epochToIso(week?.resets_at) },
        asOf: j.timestamp ?? null,
      };
    } catch { /* malformed line — keep scanning */ }
  }
  return null;
}

async function readLatestSnapshot(file: string, mtimeMs: number): Promise<CodexLimits | null> {
  const parsed = parsedRollouts.get(file);
  if (parsed?.mtimeMs === mtimeMs) return parsed.data;
  const source = Bun.file(file);
  const start = Math.max(0, source.size - ROLLOUT_TAIL_BYTES);
  let tail = await source.slice(start).text();
  if (start > 0) {
    const firstBreak = tail.indexOf("\n");
    tail = firstBreak === -1 ? "" : tail.slice(firstBreak + 1);
  }
  let data = parseLastSnapshot(tail);
  if (!data && start > 0) data = parseLastSnapshot(await source.text());
  if (data) parsedRollouts.set(file, { mtimeMs, data });
  return data;
}

async function fullScanCodexLimits(files: string[], empty: CodexLimits): Promise<CodexLimits> {
  const hitPaths = [...await grepSnapshotFiles(files)];
  const hits = (await Promise.all(hitPaths.map(async f => ({
    f, mtime: (await stat(f).catch(() => null))?.mtimeMs ?? 0,
  })))).sort((a, b) => b.mtime - a.mtime);
  for (const { f, mtime } of hits.slice(0, 3)) {
    const data = parseLastSnapshot(await Bun.file(f).text().catch(() => ""));
    if (data) {
      parsedRollouts.set(f, { mtimeMs: mtime, data });
      return data;
    }
  }
  return empty;
}

async function computeCodexLimits(): Promise<CodexLimits> {
  const empty: CodexLimits = {
    fiveHour: { pct: null, resetsAt: null },
    weekly: { pct: null, resetsAt: null },
    asOf: null,
  };
  const files = await newestSessionFiles(500);
  if (files.length === 0) {
    rolloutMemo.clear();
    parsedRollouts.clear();
    limitsCache.at = Date.now();
    limitsCache.data = empty;
    return empty;
  }
  const window = new Set(files);
  for (const file of rolloutMemo.keys()) {
    if (!window.has(file)) {
      rolloutMemo.delete(file);
      parsedRollouts.delete(file);
    }
  }
  const stats = await Promise.all(files.map(async file => ({
    file,
    value: await stat(file).catch(() => null),
  })));
  if (stats.some(entry => !entry.value)) {
    const data = await fullScanCodexLimits(files, empty);
    limitsCache.at = Date.now();
    limitsCache.data = data;
    return data;
  }

  const changed = stats.filter(({ file, value }) =>
    rolloutMemo.get(file)?.mtimeMs !== value!.mtimeMs);
  let changedHits: Set<string>;
  try {
    changedHits = await grepSnapshotFiles(changed.map(entry => entry.file), true);
  } catch {
    const data = await fullScanCodexLimits(files, empty);
    limitsCache.at = Date.now();
    limitsCache.data = data;
    return data;
  }
  for (const { file, value } of changed) {
    rolloutMemo.set(file, { mtimeMs: value!.mtimeMs, hasSnapshot: changedHits.has(file) });
  }
  if (stats.some(({ file }) => !rolloutMemo.has(file))) {
    const data = await fullScanCodexLimits(files, empty);
    limitsCache.at = Date.now();
    limitsCache.data = data;
    return data;
  }

  // Rank hits by last-write time, not session creation: a long-running old
  // session can hold newer snapshots than a short newer one.
  const hits = stats
    .filter(({ file }) => rolloutMemo.get(file)!.hasSnapshot)
    .sort((a, b) => b.value!.mtimeMs - a.value!.mtimeMs);
  for (const { file, value } of hits.slice(0, 3)) {
    const data = await readLatestSnapshot(file, value!.mtimeMs).catch(() => null);
    if (data) {
      limitsCache.at = Date.now();
      limitsCache.data = data;
      return data;
    }
  }
  if (hits.length > 0) {
    const data = await fullScanCodexLimits(files, empty);
    limitsCache.at = Date.now();
    limitsCache.data = data;
    return data;
  }
  limitsCache.at = Date.now();
  limitsCache.data = empty;
  return empty;
}

export async function getCodexLimits(): Promise<CodexLimits> {
  if (limitsCache.data && Date.now() - limitsCache.at < 60_000) return limitsCache.data;
  if (limitsInFlight) return limitsInFlight;
  const pending = computeCodexLimits();
  limitsInFlight = pending;
  const clear = () => { if (limitsInFlight === pending) limitsInFlight = null; };
  pending.then(clear, clear);
  return pending;
}

// ---------- this-month spend split by auth mode ----------

/** API-key sessions bill real money; subscription (OAuth) sessions burn
    ChatGPT plan allowance, and their costUSD is the API-EQUIVALENT value,
    not a charge. A session is counted as OAuth when its rollout recorded a
    rate-limit snapshot ("used_percent" only appears on ChatGPT-auth turns);
    a session that toggled modes mid-flight lands wholly in oauth. */
export interface CodexSpend {
  api: { tokens: number; costUSD: number };
  oauth: { tokens: number; costUSD: number };
}

export async function getCodexSpend(): Promise<CodexSpend> {
  if (spendCache.data && Date.now() - spendCache.at < 60_000) return spendCache.data;
  if (spendInFlight) return spendInFlight;
  const pending = computeSpend().catch(e => {
    if (spendCache.data) return spendCache.data; // serve stale over failing
    throw e;
  });
  spendInFlight = pending;
  const clear = () => { if (spendInFlight === pending) spendInFlight = null; };
  pending.then(clear, clear);
  return pending;
}

async function computeSpend(): Promise<CodexSpend> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const p = Bun.spawn(
    ["bunx", "ccusage", "codex", "session", "--since", localYmd(start).replaceAll("-", ""), "--json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  const sessions: any[] = (JSON.parse(out).sessions ?? [])
    .filter((s: any) => new Date(s.lastActivity ?? 0).getTime() >= start.getTime());
  const acc: CodexSpend = { api: { tokens: 0, costUSD: 0 }, oauth: { tokens: 0, costUSD: 0 } };
  if (sessions.length > 0) {
    const files = sessions.map(s => join(SESSIONS_DIR, `${s.sessionId}.jsonl`));
    const g = Bun.spawn(["grep", "-l", '"used_percent"', ...files], { stdout: "pipe", stderr: "ignore" });
    const oauthFiles = new Set((await new Response(g.stdout).text()).trim().split("\n").filter(Boolean));
    await g.exited;
    sessions.forEach((s, i) => {
      const bucket = oauthFiles.has(files[i]) ? acc.oauth : acc.api;
      bucket.tokens += s.totalTokens ?? 0;
      bucket.costUSD += s.costUSD ?? 0;
    });
  }
  spendCache.at = Date.now();
  spendCache.data = acc;
  return acc;
}

// ---------- monthly totals (ccusage codex) ----------

const localYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function getCodexMonth(): Promise<MonthUsage> {
  if (monthCache.data && Date.now() - monthCache.at < 60_000) return monthCache.data;
  if (monthInFlight) return monthInFlight;
  const pending = computeMonth().catch(e => {
    if (monthCache.data) return monthCache.data; // serve stale over failing
    throw e;
  });
  monthInFlight = pending;
  const clear = () => { if (monthInFlight === pending) monthInFlight = null; };
  pending.then(clear, clear);
  return pending;
}

async function computeMonth(): Promise<MonthUsage> {
  const now = new Date();
  // same window as the Claude card: calendar month (renewalDay is a Claude
  // subscription concept; codex bills separately, so calendar month it is)
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const p = Bun.spawn(
    ["bunx", "ccusage", "codex", "daily", "--since", localYmd(start).replaceAll("-", ""), "--json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  const entries: any[] = (JSON.parse(out).daily ?? [])
    .filter((e: any) => String(e.date) >= localYmd(start));

  const byModel = new Map<string, { tokens: number; costUSD: number }>();
  const days: MonthUsage["days"] = [];
  const byDay = new Map(entries.map(e => [String(e.date), e]));
  // ccusage codex emits a `models` object today; tolerate the claude-style
  // `modelBreakdowns` array too, since ccusage is fetched unpinned via bunx
  for (const e of entries) {
    const perModel: { model: string; tokens: number }[] = e.models
      ? Object.entries<any>(e.models).map(([model, m]) => ({ model, tokens: m.totalTokens ?? 0 }))
      : (e.modelBreakdowns ?? []).map((m: any) => ({
          model: String(m.modelName ?? "unknown"),
          tokens: (m.inputTokens ?? 0) + (m.outputTokens ?? 0) +
                  (m.cacheCreationTokens ?? 0) + (m.cacheReadTokens ?? 0),
        }));
    for (const { model, tokens } of perModel) {
      const cur = byModel.get(model) ?? { tokens: 0, costUSD: 0 };
      cur.tokens += tokens;
      byModel.set(model, cur);
    }
  }
  for (let d = new Date(start); d.getTime() <= now.getTime(); d.setDate(d.getDate() + 1)) {
    const e: any = byDay.get(localYmd(d));
    days.push({
      date: localYmd(d),
      tokens: e?.totalTokens ?? 0,
      costUSD: e?.costUSD ?? e?.totalCost ?? 0,
    });
  }

  const data: MonthUsage = {
    month: now.toISOString().slice(0, 7),
    since: null,
    totalTokens: days.reduce((a, x) => a + x.tokens, 0),
    costUSD: days.reduce((a, x) => a + x.costUSD, 0),
    models: [...byModel.entries()].map(([model, v]) => ({ model, ...v })),
    days,
  };
  monthCache.at = Date.now();
  monthCache.data = data;
  return data;
}

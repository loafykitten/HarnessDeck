import { stat } from "node:fs/promises";
import { join } from "node:path";
import { ttlCache } from "../cache";
import { CODEX_SESSIONS_DIR, codexRolloutFiles } from "../paths";
import { run } from "../proc";
import { ccusageJson, localYmd, type MonthUsage } from "./claude";

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

const rolloutMemo = new Map<string, { mtimeMs: number; hasSnapshot: boolean }>();
const parsedRollouts = new Map<string, { mtimeMs: number; data: CodexLimits }>();
const ROLLOUT_TAIL_BYTES = 256 * 1024;

async function newestSessionFiles(limit: number): Promise<string[]> {
  const out: string[] = [];
  for await (const file of codexRolloutFiles()) {
    out.push(file);
    if (out.length >= limit) break;
  }
  return out;
}

const epochToIso = (sec: unknown) =>
  typeof sec === "number" && sec > 0 ? new Date(sec * 1000).toISOString() : null;

/** Files holding a rate-limit snapshot. grep exits 1 on "no matches" and 2
    when some file was unreadable, which non-`strict` callers accept as a
    partial answer. grep not running at all (e.g. E2BIG on a long file list)
    always throws: an empty set would read as "no OAuth sessions". */
async function grepSnapshotFiles(files: string[], strict = false): Promise<Set<string>> {
  if (files.length === 0) return new Set();
  const res = await run(["grep", "-l", '"used_percent"', ...files]);
  if (res.code === null) throw new Error(`grep failed to start: ${res.err}`);
  if (strict && res.code > 1) throw new Error(`grep failed with exit code ${res.code}`);
  return new Set(res.out.trim().split("\n").filter(Boolean));
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
  if (stats.some(entry => !entry.value)) return fullScanCodexLimits(files, empty);

  const changed = stats.filter(({ file, value }) =>
    rolloutMemo.get(file)?.mtimeMs !== value!.mtimeMs);
  let changedHits: Set<string>;
  try {
    changedHits = await grepSnapshotFiles(changed.map(entry => entry.file), true);
  } catch {
    return fullScanCodexLimits(files, empty);
  }
  for (const { file, value } of changed) {
    rolloutMemo.set(file, { mtimeMs: value!.mtimeMs, hasSnapshot: changedHits.has(file) });
  }
  if (stats.some(({ file }) => !rolloutMemo.has(file))) return fullScanCodexLimits(files, empty);

  // Rank hits by last-write time, not session creation: a long-running old
  // session can hold newer snapshots than a short newer one.
  const hits = stats
    .filter(({ file }) => rolloutMemo.get(file)!.hasSnapshot)
    .sort((a, b) => b.value!.mtimeMs - a.value!.mtimeMs);
  for (const { file, value } of hits.slice(0, 3)) {
    const data = await readLatestSnapshot(file, value!.mtimeMs).catch(() => null);
    if (data) return data;
  }
  if (hits.length > 0) return fullScanCodexLimits(files, empty);
  return empty;
}

const limitsCache = ttlCache(60_000, computeCodexLimits);

export function getCodexLimits(): Promise<CodexLimits> {
  return limitsCache.get();
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

const spendCache = ttlCache(60_000, computeSpend, { staleOnError: true });

export function getCodexSpend(): Promise<CodexSpend> {
  return spendCache.get();
}

async function computeSpend(): Promise<CodexSpend> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const res = await ccusageJson(["codex", "session", "--since", localYmd(start).replaceAll("-", ""), "--json"]);
  const sessions: any[] = (res.sessions ?? [])
    .filter((s: any) => new Date(s.lastActivity ?? 0).getTime() >= start.getTime());
  const acc: CodexSpend = { api: { tokens: 0, costUSD: 0 }, oauth: { tokens: 0, costUSD: 0 } };
  if (sessions.length > 0) {
    const files = sessions.map(s => join(CODEX_SESSIONS_DIR, `${s.sessionId}.jsonl`));
    const oauthFiles = await grepSnapshotFiles(files);
    sessions.forEach((s, i) => {
      const bucket = oauthFiles.has(files[i]) ? acc.oauth : acc.api;
      bucket.tokens += s.totalTokens ?? 0;
      bucket.costUSD += s.costUSD ?? 0;
    });
  }
  return acc;
}

// ---------- monthly totals (ccusage codex) ----------

const monthCache = ttlCache(60_000, computeMonth, { staleOnError: true });

export function getCodexMonth(): Promise<MonthUsage> {
  return monthCache.get();
}

async function computeMonth(): Promise<MonthUsage> {
  const now = new Date();
  // same window as the Claude card: calendar month (renewalDay is a Claude
  // subscription concept; codex bills separately, so calendar month it is)
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const res = await ccusageJson(["codex", "daily", "--since", localYmd(start).replaceAll("-", ""), "--json"]);
  const entries: any[] = (res.daily ?? [])
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
  return data;
}

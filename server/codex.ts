import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { MonthUsage } from "./usage";

const CODEX_HOME = join(homedir(), ".codex");
// env override exists so tests can exercise the mode toggle on a copy
const CONFIG_TOML = process.env.HD_CODEX_CONFIG ?? join(CODEX_HOME, "config.toml");
const SESSIONS_DIR = join(CODEX_HOME, "sessions");

/** "api" = a top-level `model_provider = …` line is active in config.toml
    (requests go to that provider on an API key); "oauth" = the line is
    commented out, so codex falls back to its ChatGPT login. Toggling is
    exactly commenting/uncommenting that one line — everything else in the
    file is left byte-identical. */
export type CodexMode = "api" | "oauth";

/** Top-level TOML keys can only appear before the first [section] header,
    so scope the match to that prefix — `model_provider` inside a section
    (or in a comment elsewhere) must not count. */
function topLevel(text: string): string {
  const i = text.search(/^\s*\[/m);
  return i === -1 ? text : text.slice(0, i);
}

export async function getCodexMode(): Promise<CodexMode> {
  const text = await Bun.file(CONFIG_TOML).text().catch(() => "");
  return /^[ \t]*model_provider[ \t]*=/m.test(topLevel(text)) ? "api" : "oauth";
}

export async function setCodexMode(mode: CodexMode): Promise<CodexMode | { error: string }> {
  const text = await Bun.file(CONFIG_TOML).text().catch(() => null);
  if (text === null) return { error: `cannot read ${CONFIG_TOML}` };
  const head = topLevel(text);
  let newHead: string;
  if (mode === "oauth") {
    if (!/^[ \t]*model_provider[ \t]*=/m.test(head)) return "oauth"; // already
    newHead = head.replace(/^([ \t]*)(model_provider[ \t]*=)/m, "$1# $2");
  } else {
    if (/^[ \t]*model_provider[ \t]*=/m.test(head)) return "api"; // already
    if (!/^[ \t]*#[ \t]*model_provider[ \t]*=/m.test(head)) {
      return { error: "no commented model_provider line in config.toml to re-enable" };
    }
    newHead = head.replace(/^([ \t]*)#[ \t]*(model_provider[ \t]*=)/m, "$1$2");
  }
  await Bun.write(CONFIG_TOML, newHead + text.slice(head.length));
  return mode;
}

/** Display name of the configured provider: resolves the (active or
    commented) model_provider id to its [model_providers.<id>] `name`,
    falling back to the id itself. Null when config.toml has no provider. */
export async function getCodexProvider(): Promise<string | null> {
  const text = await Bun.file(CONFIG_TOML).text().catch(() => "");
  const id = topLevel(text).match(/^[ \t]*(?:#[ \t]*)?model_provider[ \t]*=[ \t]*"([^"]+)"/m)?.[1];
  if (!id) return null;
  let inSection = false;
  for (const line of text.split("\n")) {
    const header = line.match(/^\s*\[(.+?)\]\s*$/);
    if (header) {
      inSection = header[1] === `model_providers.${id}` || header[1] === `model_providers."${id}"`;
      continue;
    }
    if (!inSection) continue;
    const name = line.match(/^[ \t]*name[ \t]*=[ \t]*"([^"]+)"/);
    if (name) return name[1];
  }
  return id;
}

export interface CodexPlan {
  label: string;          // "ChatGPT Plus"
  renewsAt: string | null; // subscription_active_until
}

/** The ChatGPT plan rides in the id_token JWT that `codex login` stores in
    ~/.codex/auth.json — there is no profile endpoint to ask. The claim names
    the plan tier and the current subscription window's end (≈ renewal date).
    Null when codex has never logged in with ChatGPT (API-key-only setups). */
export async function getCodexPlan(): Promise<CodexPlan | null> {
  try {
    const auth = await Bun.file(join(CODEX_HOME, "auth.json")).json();
    const idToken: string = auth?.tokens?.id_token;
    if (!idToken) return null;
    const payload = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64url").toString(),
    )["https://api.openai.com/auth"];
    const plan: string = payload?.chatgpt_plan_type;
    if (!plan) return null;
    return {
      label: `ChatGPT ${plan.charAt(0).toUpperCase()}${plan.slice(1)}`,
      renewsAt: payload.chatgpt_subscription_active_until ?? null,
    };
  } catch {
    return null;
  }
}

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

export function invalidateCodexCaches() {
  limitsCache.at = 0;
  monthCache.at = 0;
  spendCache.at = 0;
}

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

export async function getCodexLimits(): Promise<CodexLimits> {
  if (limitsCache.data && Date.now() - limitsCache.at < 60_000) return limitsCache.data;
  const empty: CodexLimits = {
    fiveHour: { pct: null, resetsAt: null },
    weekly: { pct: null, resetsAt: null },
    asOf: null,
  };
  // API-mode turns write null rate limits, so the newest file often has no
  // snapshot at all — grep (arg order = newest first, so the first path
  // printed wins) finds the freshest file that has one without reading
  // hundreds of MB of rollouts into JS.
  const files = await newestSessionFiles(500);
  if (files.length === 0) { limitsCache.at = Date.now(); limitsCache.data = empty; return empty; }
  const p = Bun.spawn(["grep", "-l", '"used_percent"', ...files], { stdout: "pipe", stderr: "ignore" });
  const hitPaths = (await new Response(p.stdout).text()).trim().split("\n").filter(Boolean);
  await p.exited;
  // Rank hits by last-write time, not session creation: a long-running old
  // session can hold newer snapshots than a short newer one.
  const hits = (await Promise.all(hitPaths.map(async f => ({
    f, mtime: (await stat(f).catch(() => null))?.mtimeMs ?? 0,
  })))).sort((a, b) => b.mtime - a.mtime).map(x => x.f);
  for (const file of hits.slice(0, 3)) {
    const text = await Bun.file(file).text().catch(() => "");
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
        const data: CodexLimits = {
          fiveHour: { pct: five?.used_percent ?? null, resetsAt: epochToIso(five?.resets_at) },
          weekly: { pct: week?.used_percent ?? null, resetsAt: epochToIso(week?.resets_at) },
          asOf: j.timestamp ?? null,
        };
        limitsCache.at = Date.now();
        limitsCache.data = data;
        return data;
      } catch { /* malformed line — keep scanning */ }
    }
  }
  limitsCache.at = Date.now();
  limitsCache.data = empty;
  return empty;
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
  try {
    return await computeSpend();
  } catch (e) {
    if (spendCache.data) return spendCache.data; // serve stale over failing
    throw e;
  }
}

async function computeSpend(): Promise<CodexSpend> {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const p = Bun.spawn(
    ["bunx", "ccusage", "codex", "session", "--json"],
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
  try {
    return await computeMonth();
  } catch (e) {
    if (monthCache.data) return monthCache.data; // serve stale over failing
    throw e;
  }
}

async function computeMonth(): Promise<MonthUsage> {
  const now = new Date();
  // same window as the Claude card: calendar month (renewalDay is a Claude
  // subscription concept; codex bills separately, so calendar month it is)
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const p = Bun.spawn(
    ["bunx", "ccusage", "codex", "daily", "--json"],
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

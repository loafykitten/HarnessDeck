import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { getAppConfig } from "./config";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");
const DISK_CACHE = join(homedir(), ".config", "harnessdeck", "usage-cache.json");
// pre-rename location (Claude Command era) — read-only fallback
const LEGACY_DISK_CACHE = join(homedir(), ".config", "claude-command", "usage-cache.json");

/** Last-good API responses survive restarts: the server restarts often
    (KeepAlive, updates) and the OAuth endpoints 429 when hit cold each time. */
async function diskCache(): Promise<Record<string, unknown>> {
  try { return await Bun.file(DISK_CACHE).json(); } catch { /* fall through */ }
  try { return await Bun.file(LEGACY_DISK_CACHE).json(); } catch { return {}; }
}
async function saveDiskCache(key: string, value: unknown): Promise<void> {
  const all = await diskCache();
  all[key] = value;
  await mkdir(dirname(DISK_CACHE), { recursive: true });
  await Bun.write(DISK_CACHE, JSON.stringify(all));
}

export interface Limits {
  fiveHour: { pct: number | null; resetsAt: string | null };
  weekly: { pct: number | null; resetsAt: string | null };
  weeklyModel: { pct: number; model: string } | null;
  plan: { label: string; renewsAt: string | null };
}

interface Cache<T> { at: number; data: T | null }
const limitsCache: Cache<Limits> = { at: 0, data: null };

async function oauthHeaders(): Promise<Record<string, string>> {
  const creds = await Bun.file(CREDS_PATH).json();
  return {
    Authorization: `Bearer ${creds.claudeAiOauth.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
}

export interface Profile {
  planLabel: string;
  renewsAt: string | null; // next monthly anniversary of subscription start
  displayName: string | null;
}

const profileCache: Cache<Profile> = { at: 0, data: null };

/** Next monthly anniversary of the subscription start date. Assumes monthly
    billing (annual plans will show the monthly anniversary instead). */
function nextRenewal(createdIso: string): string {
  const created = new Date(createdIso);
  const now = new Date();
  const next = new Date(now.getFullYear(), now.getMonth(), created.getDate(),
    created.getHours(), created.getMinutes());
  if (next.getTime() <= now.getTime()) next.setMonth(next.getMonth() + 1);
  return next.toISOString();
}

/** Next/previous occurrence of a configured renewal day-of-month. Days past
    a month's end clamp to its last day (renewalDay 31 → Feb 28). */
function renewalFromDay(day: number, direction: "next" | "prev"): Date {
  const now = new Date();
  const clamp = (y: number, m: number) =>
    new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  let d = clamp(now.getFullYear(), now.getMonth());
  if (direction === "next" && d.getTime() <= now.getTime()) {
    d = clamp(now.getFullYear(), now.getMonth() + 1);
  } else if (direction === "prev" && d.getTime() > now.getTime()) {
    d = clamp(now.getFullYear(), now.getMonth() - 1);
  }
  return d;
}

export function invalidateUsageCaches() {
  limitsCache.at = 0;
  monthCache.at = 0;
}

/** The credentials file's subscriptionType goes stale after plan changes —
    the profile endpoint is authoritative. */
export async function getProfile(): Promise<Profile> {
  if (profileCache.data && Date.now() - profileCache.at < 60 * 60_000) return profileCache.data;
  const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: await oauthHeaders(),
  });
  if (!res.ok) {
    if (profileCache.data) return profileCache.data;
    const disk = (await diskCache()).profile as Profile | undefined;
    if (disk) return disk;
    throw new Error(`oauth profile endpoint: HTTP ${res.status}`);
  }
  const j = await res.json();
  const tier: string = j.organization?.rate_limit_tier ?? "";
  let planLabel = "Claude";
  if (j.account?.has_claude_max) {
    planLabel = "Claude Max";
    const mult = tier.match(/max_(\d+)x/);
    if (mult) planLabel += ` ${mult[1]}×`;
  } else if (j.account?.has_claude_pro) {
    planLabel = "Claude Pro";
  } else if (j.organization?.organization_type) {
    planLabel = "Claude " + String(j.organization.organization_type).replace(/^claude_/, "");
  }
  const createdAt = j.organization?.subscription_created_at ?? null;
  const data: Profile = {
    planLabel,
    renewsAt: createdAt ? nextRenewal(createdAt) : null,
    displayName: j.account?.display_name ?? null,
  };
  profileCache.at = Date.now();
  profileCache.data = data;
  saveDiskCache("profile", data).catch(() => {});
  return data;
}

/** Public API: cached limits with config-derived values applied at serve
    time — never baked into the cache, where they'd go stale (learned the
    hard way when a cached renewsAt outlived a renewalDay change). */
export async function getLimits(): Promise<Limits> {
  const base = await getLimitsRaw();
  const cfg = await getAppConfig();
  if (!cfg.renewalDay) return base;
  return {
    ...base,
    plan: { ...base.plan, renewsAt: renewalFromDay(cfg.renewalDay, "next").toISOString() },
  };
}

async function getLimitsRaw(): Promise<Limits> {
  if (limitsCache.data && Date.now() - limitsCache.at < 60_000) return limitsCache.data;
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: await oauthHeaders(),
  });
  if (!res.ok) {
    if (limitsCache.data) return limitsCache.data; // serve stale over failing
    const disk = (await diskCache()).limits as Limits | undefined;
    if (disk) {
      limitsCache.at = Date.now() - 30_000; // retry soon, but stop hammering
      limitsCache.data = disk;
      return disk;
    }
    throw new Error(`oauth usage endpoint: HTTP ${res.status}`);
  }
  const j = await res.json();
  const scoped = (j.limits ?? []).find((l: any) => l.kind === "weekly_scoped");
  const profile = await getProfile().catch((): Profile =>
    ({ planLabel: "Claude", renewsAt: null, displayName: null }));
  const data: Limits = {
    fiveHour: { pct: j.five_hour?.utilization ?? null, resetsAt: j.five_hour?.resets_at ?? null },
    weekly: { pct: j.seven_day?.utilization ?? null, resetsAt: j.seven_day?.resets_at ?? null },
    weeklyModel: scoped
      ? { pct: scoped.percent, model: scoped.scope?.model?.display_name ?? "model" }
      : null,
    plan: { label: profile.planLabel, renewsAt: profile.renewsAt },
  };
  limitsCache.at = Date.now();
  limitsCache.data = data;
  saveDiskCache("limits", data).catch(() => {});
  return data;
}

export interface MonthUsage {
  month: string;
  since: string | null; // billing-cycle start when renewalDay is configured
  totalTokens: number;
  costUSD: number; // API-equivalent, Claude models only
  models: { model: string; tokens: number; costUSD: number }[];
  days: { date: string; tokens: number; costUSD: number }[]; // zero-filled, window start → today
}

const monthCache: Cache<MonthUsage> = { at: 0, data: null };

/** Sum Claude-model tokens/cost from a list of ccusage entries. */
function sumClaudeModels(entries: any[]) {
  const byModel = new Map<string, { tokens: number; costUSD: number }>();
  for (const entry of entries) {
    for (const m of entry.modelBreakdowns ?? []) {
      if (!String(m.modelName).startsWith("claude")) continue;
      const cur = byModel.get(m.modelName) ?? { tokens: 0, costUSD: 0 };
      cur.tokens += (m.inputTokens ?? 0) + (m.outputTokens ?? 0) +
                    (m.cacheCreationTokens ?? 0) + (m.cacheReadTokens ?? 0);
      cur.costUSD += m.cost ?? 0;
      byModel.set(m.modelName, cur);
    }
  }
  return [...byModel.entries()].map(([model, v]) => ({ model, ...v }));
}

const localYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function getMonth(): Promise<MonthUsage> {
  // 60s: short enough that the dashboard visibly ticks while sessions run
  if (monthCache.data && Date.now() - monthCache.at < 60_000) return monthCache.data;
  try {
    return await computeMonth();
  } catch (e) {
    if (monthCache.data) return monthCache.data; // serve stale over failing
    throw e;
  }
}

async function computeMonth(): Promise<MonthUsage> {
  const cfg = await getAppConfig();
  // window start: last renewal date when configured, else first of the calendar month
  const now = new Date();
  const start = cfg.renewalDay
    ? renewalFromDay(cfg.renewalDay, "prev")
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const p = Bun.spawn(
    ["bunx", "ccusage", "daily", "--since", localYmd(start).replaceAll("-", ""), "--json"],
    { stdout: "pipe", stderr: "ignore" },
  );
  const out = await new Response(p.stdout).text();
  await p.exited;
  const entries: any[] = JSON.parse(out).daily ?? [];

  // per-day Claude-only series, zero-filled so the chart shows quiet days too
  const byDay = new Map(entries.map(e => [String(e.period), sumClaudeModels([e])]));
  const days: MonthUsage["days"] = [];
  for (let d = new Date(start); d.getTime() <= now.getTime(); d.setDate(d.getDate() + 1)) {
    const dayModels = byDay.get(localYmd(d)) ?? [];
    days.push({
      date: localYmd(d),
      tokens: dayModels.reduce((a, m) => a + m.tokens, 0),
      costUSD: dayModels.reduce((a, m) => a + m.costUSD, 0),
    });
  }

  const models = sumClaudeModels(entries);
  const data: MonthUsage = {
    month: new Date().toISOString().slice(0, 7),
    since: cfg.renewalDay ? start.toISOString() : null,
    totalTokens: models.reduce((a, m) => a + m.tokens, 0),
    costUSD: models.reduce((a, m) => a + m.costUSD, 0),
    models,
    days,
  };
  monthCache.at = Date.now();
  monthCache.data = data;
  return data;
}

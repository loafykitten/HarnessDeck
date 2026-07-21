import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { getAppConfig } from "../config/config";

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
  fetchedAt: string;   // ISO of the fetch this data came from
  stale?: boolean;     // set only on cache-fallback copies, never persisted
  staleReason?: string;
  authExpired?: boolean; // no valid token in either store — needs `claude` re-login
}

interface Cache<T> { at: number; data: T | null }
const limitsCache: Cache<Limits> = { at: 0, data: null };

/** OAuth creds live in two stores that can disagree: the Keychain entry
    Claude Code maintains, and ~/.claude/.credentials.json used over ssh.
    Either can hold the fresher token, so we read both and pick the
    later-expiring one. We never refresh tokens ourselves — that's Claude
    Code's job; rotating them here would fight it. */
interface OAuthCreds { accessToken: string; expiresAt: number }
const CRED_TTL = 60_000;
const credCache: { at: number; creds: OAuthCreds | null } = { at: 0, creds: null };

function parseCreds(raw: unknown): OAuthCreds | null {
  const o = (raw as any)?.claudeAiOauth;
  if (!o?.accessToken) return null;
  return { accessToken: o.accessToken, expiresAt: Number(o.expiresAt) || 0 };
}

async function fileCreds(): Promise<OAuthCreds | null> {
  try { return parseCreds(await Bun.file(CREDS_PATH).json()); } catch { return null; }
}

/** Keychain read degrades to null off macOS or when the entry is absent. */
async function keychainCreds(): Promise<OAuthCreds | null> {
  if (process.platform !== "darwin") return null;
  try {
    const p = Bun.spawn(
      ["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { stdout: "pipe", stderr: "ignore" },
    );
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    return parseCreds(JSON.parse(out.trim()));
  } catch { return null; }
}

async function freshestCreds(force = false): Promise<OAuthCreds | null> {
  if (!force && credCache.creds && Date.now() - credCache.at < CRED_TTL) return credCache.creds;
  const found = (await Promise.all([fileCreds(), keychainCreds()]))
    .filter((c): c is OAuthCreds => c != null)
    .sort((a, b) => b.expiresAt - a.expiresAt); // later expiry wins; a valid token always outranks an expired one
  credCache.creds = found[0] ?? null;
  credCache.at = Date.now();
  return credCache.creds;
}

function invalidateCredCache() { credCache.at = 0; credCache.creds = null; }

/** No usable token anywhere: both stores expired per expiresAt, or both
    unreadable. Re-reads past the 60s cache before deciding, in case Claude
    Code just refreshed the Keychain. */
async function credsAreExpired(): Promise<boolean> {
  const c = await freshestCreds();
  if (c && c.expiresAt > Date.now()) return false;
  const fresh = await freshestCreds(true);
  return !fresh || fresh.expiresAt <= Date.now();
}

async function oauthHeaders(force = false): Promise<Record<string, string>> {
  const creds = await freshestCreds(force);
  if (!creds) throw new Error("no Claude OAuth credentials (checked Keychain and credentials.json)");
  return {
    Authorization: `Bearer ${creds.accessToken}`,
    "anthropic-beta": "oauth-2025-04-20",
  };
}

/** Claude Code may have refreshed the Keychain token since we cached ours, so
    a 401/403 earns one retry with freshly re-read creds. */
async function oauthFetch(endpoint: string): Promise<Response> {
  const res = await fetch(endpoint, { headers: await oauthHeaders() });
  if (res.status !== 401 && res.status !== 403) return res;
  invalidateCredCache();
  return fetch(endpoint, { headers: await oauthHeaders(true) });
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
  backoff.until = 0;
  backoff.attempts = 0;
  invalidateCredCache();
}

/** The credentials file's subscriptionType goes stale after plan changes —
    the profile endpoint is authoritative. */
export async function getProfile(): Promise<Profile> {
  if (profileCache.data && Date.now() - profileCache.at < 60 * 60_000) return profileCache.data;
  const res = await oauthFetch("https://api.anthropic.com/api/oauth/profile");
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

// A failing endpoint used to be retried every 30–60s, which kept it 429-ing.
// Now we honor Retry-After (else exponential backoff, capped) and serve cache
// without hitting the network until the window passes.
const MAX_BACKOFF = 10 * 60_000;
const backoff = { until: 0, attempts: 0 };

function parseRetryAfter(h: string | null): number | null {
  if (!h) return null;
  const secs = Number(h);
  if (Number.isFinite(secs)) return secs * 1000;
  const at = Date.parse(h);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}
function scheduleBackoff(retryAfterMs: number | null) {
  backoff.attempts += 1;
  const exp = Math.min(MAX_BACKOFF, 30_000 * 2 ** (backoff.attempts - 1));
  backoff.until = Date.now() + Math.min(MAX_BACKOFF, retryAfterMs ?? exp);
}

/** Cache-fallback copy of the limits, flagged so the UI and /api/usage can
    say the data is old. Warms memory from disk but leaves the cache timestamp
    untouched, so we keep re-evaluating rather than treating disk data as live. */
async function staleLimits(reason: string, authExpired = false): Promise<Limits | null> {
  const src = limitsCache.data ?? ((await diskCache()).limits as Limits | undefined) ?? null;
  if (!src) return null;
  if (!limitsCache.data) limitsCache.data = src;
  return { ...src, stale: true, staleReason: reason, ...(authExpired ? { authExpired: true } : {}) };
}

/** No cache to fall back on and the sign-in is dead: a minimal flagged payload
    so the route/UI can prompt for re-login instead of throwing an opaque error. */
function authExpiredLimits(): Limits {
  return {
    fiveHour: { pct: null, resetsAt: null },
    weekly: { pct: null, resetsAt: null },
    weeklyModel: null,
    plan: { label: "Claude", renewsAt: null },
    fetchedAt: limitsCache.data?.fetchedAt ?? new Date().toISOString(),
    stale: true,
    staleReason: "sign-in expired",
    authExpired: true,
  };
}

async function getLimitsRaw(): Promise<Limits> {
  if (limitsCache.data && !limitsCache.data.stale && Date.now() - limitsCache.at < 60_000) return limitsCache.data;

  if (Date.now() < backoff.until) {
    const cached = await staleLimits(`rate-limited until ${new Date(backoff.until).toLocaleTimeString()}`);
    if (cached) return cached;
    throw new Error(`oauth usage endpoint: backing off until ${new Date(backoff.until).toISOString()}`);
  }

  // Dead sign-in: skip the doomed request; a 401 would only add noise.
  if (await credsAreExpired()) {
    return (await staleLimits("sign-in expired", true)) ?? authExpiredLimits();
  }

  let res: Response;
  try {
    res = await oauthFetch("https://api.anthropic.com/api/oauth/usage");
  } catch (e) {
    const cached = await staleLimits(String(e));
    if (cached) return cached;
    throw e;
  }
  if (!res.ok) {
    // A 401/403 that survived oauthFetch's one retry means the token is rejected
    // (revoked, or expired between our check and the call) — treat as auth-expired.
    const authExpired = res.status === 401 || res.status === 403;
    if (res.status === 429) scheduleBackoff(parseRetryAfter(res.headers.get("retry-after")));
    const cached = await staleLimits(authExpired ? "sign-in expired" : `HTTP ${res.status}`, authExpired);
    if (cached) return cached;
    if (authExpired) return authExpiredLimits();
    throw new Error(`oauth usage endpoint: HTTP ${res.status}`);
  }

  backoff.attempts = 0;
  backoff.until = 0;
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
    fetchedAt: new Date().toISOString(),
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

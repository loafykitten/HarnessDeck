import { join } from "node:path";
import { getAppConfig } from "../config/config";
import { ttlCache } from "../cache";
import { CLAUDE_HOME, LEGACY_STATE_DIR, STATE_DIR } from "../paths";
import { run } from "../proc";
import { readJson, serialQueue, writeJsonAtomic } from "../store";

const CREDS_PATH = join(CLAUDE_HOME, ".credentials.json");
const DISK_CACHE = join(STATE_DIR, "usage-cache.json");

/** Last-good API responses survive restarts: the server restarts often
    (KeepAlive, updates) and the OAuth endpoints 429 when hit cold each time. */
async function diskCache(): Promise<Record<string, unknown>> {
  const all = await readJson(DISK_CACHE, join(LEGACY_STATE_DIR, "usage-cache.json"));
  return all && typeof all === "object" ? all as Record<string, unknown> : {};
}
// Profile and limits saves land back-to-back; unserialized, the second
// read-modify-write would drop the first one's key.
const diskWrites = serialQueue();
function saveDiskCache(key: string, value: unknown): Promise<void> {
  return diskWrites(async () => {
    const all = await diskCache();
    all[key] = value;
    await writeJsonAtomic(DISK_CACHE, all);
  });
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

/** The last successful fetch, kept apart from the TTL cache: cache-fallback
    copies flow through that cache too, but are never fresh and never become
    the source for the next fallback. */
let lastGoodLimits: Limits | null = null;
const limitsCache = ttlCache(60_000, computeLimitsRaw, { isFresh: limits => !limits.stale });

/** OAuth creds live in two stores that can disagree: the Keychain entry
    Claude Code maintains, and ~/.claude/.credentials.json used over ssh.
    Either can hold the fresher token, so we read both and pick the
    later-expiring one. We never refresh tokens ourselves — that's Claude
    Code's job; rotating them here would fight it. */
interface OAuthCreds { accessToken: string; expiresAt: number }
const CRED_TTL = 60_000;
const CRED_NULL_TTL = 15_000;
const credCache: { at: number; creds: OAuthCreds | null; loaded: boolean } = { at: 0, creds: null, loaded: false };

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
  const res = await run(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]);
  if (!res.ok) return null;
  try { return parseCreds(JSON.parse(res.out.trim())); } catch { return null; }
}

async function loadFreshestCreds(force = false): Promise<{ creds: OAuthCreds | null; fromCache: boolean }> {
  const ttl = credCache.creds ? CRED_TTL : CRED_NULL_TTL;
  if (!force && credCache.loaded && Date.now() - credCache.at < ttl) {
    return { creds: credCache.creds, fromCache: true };
  }
  const found = (await Promise.all([fileCreds(), keychainCreds()]))
    .filter((c): c is OAuthCreds => c != null)
    .sort((a, b) => b.expiresAt - a.expiresAt); // later expiry wins; a valid token always outranks an expired one
  credCache.creds = found[0] ?? null;
  credCache.at = Date.now();
  credCache.loaded = true;
  return { creds: credCache.creds, fromCache: false };
}

async function freshestCreds(force = false): Promise<OAuthCreds | null> {
  return (await loadFreshestCreds(force)).creds;
}

function invalidateCredCache() { credCache.at = 0; credCache.creds = null; credCache.loaded = false; }

/** No usable token anywhere: both stores expired per expiresAt, or both
    unreadable. Re-reads past the 60s cache before deciding, in case Claude
    Code just refreshed the Keychain. */
async function credsAreExpired(): Promise<boolean> {
  const first = await loadFreshestCreds();
  if (first.creds && first.creds.expiresAt > Date.now()) return false;
  if (!first.fromCache || first.creds === null) return true;
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

/** The fields we read from the (undocumented) oauth profile endpoint. */
interface OAuthProfile {
  account?: { has_claude_max?: boolean; has_claude_pro?: boolean; display_name?: string };
  organization?: { rate_limit_tier?: string; organization_type?: string; subscription_created_at?: string };
}

/** The fields we read from the (undocumented) oauth usage endpoint. */
interface OAuthUsage {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  limits?: { kind?: string; percent: number; scope?: { model?: { display_name?: string } } }[];
}

const profileCache: { at: number; data: Profile | null } = { at: 0, data: null };

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

export function invalidateClaudeMonthCache() {
  monthCache.invalidate();
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
  const j = await res.json() as OAuthProfile;
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
  const base = await limitsCache.get();
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
    say the data is old. Warms memory from disk; the stale flag keeps the TTL
    cache from serving the copy, so we keep re-evaluating rather than treating
    old data as live. */
async function staleLimits(reason: string, authExpired = false): Promise<Limits | null> {
  const src = lastGoodLimits ?? ((await diskCache()).limits as Limits | undefined) ?? null;
  if (!src) return null;
  lastGoodLimits = src;
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
    fetchedAt: lastGoodLimits?.fetchedAt ?? new Date().toISOString(),
    stale: true,
    staleReason: "sign-in expired",
    authExpired: true,
  };
}

async function computeLimitsRaw(): Promise<Limits> {
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
  const j = await res.json() as OAuthUsage;
  const scoped = (j.limits ?? []).find(l => l.kind === "weekly_scoped");
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
  lastGoodLimits = data;
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

// 60s: short enough that the dashboard visibly ticks while sessions run
const monthCache = ttlCache(60_000, computeMonth, { staleOnError: true });

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

/** ccusage runs unpinned via bunx, so a registry stall or a wedged parse
    can hang it — and the in-flight promise every /api/usage request joins
    would never settle. bunx runs ccusage as a child, so it gets its own
    process group and the whole group is killed — killing bunx alone would
    orphan the hung child. The deadline also races the read rather than
    trusting the kill to close stdout. The rejection lets callers fall back
    to their stale cache. */
const CCUSAGE_TIMEOUT_MS = 60_000;
export async function ccusageJson(args: string[]): Promise<any> {
  const p = Bun.spawn(["bunx", "ccusage", ...args], { stdout: "pipe", stderr: "ignore", detached: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      try { process.kill(-p.pid, "SIGKILL"); } catch { /* already gone */ }
      reject(new Error(`ccusage ${args[0]} timed out after ${CCUSAGE_TIMEOUT_MS / 1000}s`));
    }, CCUSAGE_TIMEOUT_MS);
  });
  const read = (async () => {
    const out = await new Response(p.stdout).text();
    await p.exited;
    return out;
  })();
  read.catch(() => {}); // a loser that rejects after the deadline isn't unhandled
  try {
    return JSON.parse(await Promise.race([read, deadline]));
  } finally {
    clearTimeout(timer);
  }
}

export const localYmd = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function getMonth(): Promise<MonthUsage> {
  return monthCache.get();
}

async function computeMonth(): Promise<MonthUsage> {
  const cfg = await getAppConfig();
  // window start: last renewal date when configured, else first of the calendar month
  const now = new Date();
  const start = cfg.renewalDay
    ? renewalFromDay(cfg.renewalDay, "prev")
    : new Date(now.getFullYear(), now.getMonth(), 1);
  const res = await ccusageJson(["claude", "daily", "--since", localYmd(start).replaceAll("-", ""), "--json"]);
  const entries: any[] = res.daily ?? [];

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
  return data;
}

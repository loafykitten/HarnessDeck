import { homedir } from "node:os";
import { join } from "node:path";

const CREDS_PATH = join(homedir(), ".claude", ".credentials.json");

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

/** The credentials file's subscriptionType goes stale after plan changes —
    the profile endpoint is authoritative. */
export async function getProfile(): Promise<Profile> {
  if (profileCache.data && Date.now() - profileCache.at < 60 * 60_000) return profileCache.data;
  const res = await fetch("https://api.anthropic.com/api/oauth/profile", {
    headers: await oauthHeaders(),
  });
  if (!res.ok) {
    if (profileCache.data) return profileCache.data;
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
  return data;
}

export async function getLimits(): Promise<Limits> {
  if (limitsCache.data && Date.now() - limitsCache.at < 60_000) return limitsCache.data;
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: await oauthHeaders(),
  });
  if (!res.ok) {
    if (limitsCache.data) return limitsCache.data; // serve stale over failing
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
  return data;
}

export interface MonthUsage {
  month: string;
  totalTokens: number;
  costUSD: number; // API-equivalent, Claude models only
  models: { model: string; tokens: number; costUSD: number }[];
}

const monthCache: Cache<MonthUsage> = { at: 0, data: null };

export async function getMonth(): Promise<MonthUsage> {
  if (monthCache.data && Date.now() - monthCache.at < 300_000) return monthCache.data;
  const p = Bun.spawn(["bunx", "ccusage", "monthly", "--json"], {
    stdout: "pipe", stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  const j = JSON.parse(out);
  const thisMonth = new Date().toISOString().slice(0, 7);
  const entry = (j.monthly ?? []).find((m: any) => m.month === thisMonth)
    ?? (j.monthly ?? []).at(-1);
  if (!entry) throw new Error("ccusage returned no monthly data");
  // Only count Claude models — ccusage also tracks codex/opencode agents.
  const models = (entry.modelBreakdowns ?? [])
    .filter((m: any) => String(m.modelName).startsWith("claude"))
    .map((m: any) => ({
      model: m.modelName,
      tokens: (m.inputTokens ?? 0) + (m.outputTokens ?? 0) +
              (m.cacheCreationTokens ?? 0) + (m.cacheReadTokens ?? 0),
      costUSD: m.cost ?? 0,
    }));
  const data: MonthUsage = {
    month: entry.month ?? thisMonth,
    totalTokens: models.reduce((a: number, m: any) => a + m.tokens, 0),
    costUSD: models.reduce((a: number, m: any) => a + m.costUSD, 0),
    models,
  };
  monthCache.at = Date.now();
  monthCache.data = data;
  return data;
}

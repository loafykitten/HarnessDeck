/** Shared API contract types — mirrors the server's JSON payloads. */
import type { PetId } from "../components/pets/pets";

export type SessionStatus = "working" | "waiting" | "idle";
export type HarnessId = "claude" | "codex";
export type CodexMode = "api" | "oauth";
export interface HarnessMeta {
  id: HarnessId; label: string;
  mdLabel: string; settingsLabel: string; settingsFormat: "json" | "toml";
}
export interface SessionInfo {
  id: string; project: string; name: string; harness: HarnessId;
  created: number; activity: number; attached: number;
  status: SessionStatus;
}
export interface ProjectInfo {
  name: string; dir: string; lastActivity: number | null;
  sessions: { id: string; name: string; activity: number; harness: HarnessId }[];
  git?: {
    branch: string; ahead: number | null; dirty: number;
    branches: string[];
    worktrees: { branch: string; path: string }[];
  } | null;
}
export type TreeGitStatus = "tracked" | "untracked" | "ignored" | "none";
export interface TreeNode {
  name: string; path: string; kind: "dir" | "file"; hidden: boolean;
  ext?: string; git: TreeGitStatus; children?: TreeNode[];
}
export interface ProjectTree { root: TreeNode; truncated: boolean; git: boolean }
export interface ProjectStack { stack: string[] }
export interface MonthUsage {
  month: string; since: string | null; totalTokens: number; costUSD: number;
  days: { date: string; tokens: number; costUSD: number }[];
}
export interface Usage {
  limits: {
    fiveHour: { pct: number | null; resetsAt: string | null };
    weekly: { pct: number | null; resetsAt: string | null };
    weeklyModel: { pct: number; model: string } | null;
    plan: { label: string; renewsAt: string | null };
    fetchedAt: string;
    stale?: boolean;
    authExpired?: boolean;
  } | null;
  month: MonthUsage | null;
  codex: {
    mode: CodexMode;
    providerName: string | null;
    limits: {
      fiveHour: { pct: number | null; resetsAt: string | null };
      weekly: { pct: number | null; resetsAt: string | null };
      asOf: string | null;
    } | null;
    month: MonthUsage | null;
    spend: {
      api: { tokens: number; costUSD: number };
      oauth: { tokens: number; costUSD: number };
    } | null;
    plan: { label: string; renewsAt: string | null } | null;
  } | null;
  errors: string[];
}
export interface Greeting { salutation: string; weather: string | null; whimsy: string }
export type NewsVendor = "anthropic" | "openai" | "zai" | "moonshot" | "deepseek";
export type NewsKind = "release" | "outage" | "resolved" | "news";
export interface NewsItem {
  id: string; vendor: NewsVendor; kind: NewsKind;
  headline: string; url: string; at: number;
}
export interface News { items: NewsItem[]; updatedAt: number | null }
export interface UpdateJob {
  status: "running" | "done" | "error";
  startedAt: number; finishedAt: number | null;
  from: string | null; output: string;
}
export interface UpdateStatus {
  installed: string | null; latest: string | null;
  updateAvailable: boolean; checkedAt: number;
  error: string | null; job: UpdateJob | null;
}
export type Updates = Record<HarnessId, UpdateStatus>;
export interface AppConfig { displayName: string; zip: string; greetingEnabled: boolean; renewalDay: number | null; pet: PetId }
export interface SkillSummary { name: string; description: string; files: number; updated: number; harnesses: HarnessId[] }
export interface SkillDetail {
  name: string;
  frontmatter: Record<string, string>;
  skillMd?: string;
  files: { path: string; size: number; mtime: number; editable: boolean }[];
  harnesses: HarnessId[];
}
export interface SkillJob {
  id: string; skillName: string;
  status: "running" | "done" | "error";
  error?: string; startedAt: number; completedAt?: number;
}

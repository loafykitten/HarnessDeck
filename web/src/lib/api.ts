export type SessionStatus = "working" | "waiting" | "idle";
export interface SessionInfo {
  id: string; project: string; name: string;
  created: number; activity: number; attached: number;
  status: SessionStatus;
}
export interface ProjectInfo {
  name: string; dir: string; lastActivity: number | null;
  sessions: { id: string; name: string; activity: number }[];
}
export interface Usage {
  limits: {
    fiveHour: { pct: number | null; resetsAt: string | null };
    weekly: { pct: number | null; resetsAt: string | null };
    weeklyModel: { pct: number; model: string } | null;
    plan: { label: string; renewsAt: string | null };
  } | null;
  month: { month: string; since: string | null; totalTokens: number; costUSD: number } | null;
  errors: string[];
}
export interface Greeting { salutation: string; weather: string | null; whimsy: string }
export interface AppConfig { displayName: string; zip: string; greetingEnabled: boolean; renewalDay: number | null }
export interface SkillSummary { name: string; description: string; files: number; updated: number }
export interface SkillDetail {
  name: string;
  frontmatter: Record<string, string>;
  files: { path: string; size: number; mtime: number; editable: boolean }[];
}
export interface SkillJob {
  id: string; skillName: string;
  status: "running" | "done" | "error";
  error?: string; startedAt: number;
}

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  projects: () => j<ProjectInfo[]>("/api/projects"),
  sessions: () => j<SessionInfo[]>("/api/sessions"),
  createSession: (project: string, name: string) =>
    j<{ id: string }>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, name }),
    }),
  killSession: (id: string) =>
    j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  usage: () => j<Usage>("/api/usage"),
  greeting: () => j<Greeting>("/api/greeting"),
  appConfig: () => j<AppConfig>("/api/config/app"),
  saveAppConfig: (cfg: Partial<AppConfig>) =>
    j<AppConfig>("/api/config/app", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  settingsText: () => fetch("/api/config/settings").then(r => r.text()),
  saveSettingsText: (text: string) =>
    j<{ ok: boolean }>("/api/config/settings", { method: "PUT", body: text }),
  claudeMd: () => fetch("/api/config/claude-md").then(r => r.text()),
  saveClaudeMd: (text: string) =>
    j<{ ok: boolean }>("/api/config/claude-md", { method: "PUT", body: text }),
  pasteImage: (sessionId: string, blob: Blob) =>
    j<{ ok: boolean; path: string }>(
      `/api/sessions/${encodeURIComponent(sessionId)}/image`,
      { method: "POST", headers: { "content-type": blob.type || "image/png" }, body: blob },
    ),
  skills: () => j<SkillSummary[]>("/api/skills"),
  skill: (name: string) => j<SkillDetail>(`/api/skills/${encodeURIComponent(name)}`),
  skillFile: (name: string, path: string) =>
    fetch(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
  saveSkillFile: (name: string, path: string, content: string) =>
    j<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/file?path=${encodeURIComponent(path)}`,
      { method: "PUT", body: content }),
  deleteSkill: (name: string) =>
    j<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}`, { method: "DELETE" }),
  installSkill: (url: string) =>
    j<{ installed: string[]; skipped: string[] }>("/api/skills/install", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
    }),
  generateSkill: (name: string, prompt: string) =>
    j<{ job: string }>("/api/skills/generate", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, prompt }),
    }),
  skillJob: (id: string) => j<SkillJob>(`/api/skills/jobs/${id}`),
};

export function fmtTokens(n: number): string {
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(n);
}

export function fmtUSD(n: number): string {
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export function fmtClock(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  const sameDay = d.toDateString() === new Date().toDateString();
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return sameDay ? time : d.toLocaleDateString("en-US", { weekday: "short" }) + " " + time;
}

export function fmtAgo(ms: number | null): string {
  if (!ms) return "never";
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 21) return `${Math.floor(s / 86400)}d ago`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400 / 7)}w ago`;
  return `${Math.floor(s / 86400 / 30)}mo ago`;
}

export function fmtDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Stable per-project avatar gradient. */
export function projectGradient(name: string): string {
  const palette = [
    ["#ff5ec7", "#5aa8ff"], ["#a06bff", "#5aa8ff"], ["#ff8a5e", "#ff5ec7"],
    ["#5ae3c7", "#5aa8ff"], ["#8f86b8", "#5aa8ff"], ["#c8309a", "#8f86b8"],
    ["#ffd75e", "#ff5ec7"], ["#5affa3", "#a06bff"],
  ];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  const [a, b] = palette[h % palette.length];
  return `linear-gradient(135deg,${a},${b})`;
}

export function initials(name: string): string {
  const parts = name.split(/[-_ ]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? parts[0]?.[1] ?? "")).toUpperCase();
}

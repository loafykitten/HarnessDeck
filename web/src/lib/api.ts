/** Typed fetch client for the HarnessDeck server API. */
import type {
  AppConfig, CodexMode, Greeting, HarnessId, HarnessMeta, News,
  ProjectInfo, ProjectStack, ProjectTree, SessionInfo, SkillDetail,
  SkillJob, SkillSummary, Updates, UpdateJob, Usage,
} from "../types/api";
import type { ChatEffort, ChatHarness, ChatModel, ChatPermissionMode, ChatSession } from "../types/chat";

async function j<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.error ?? `HTTP ${res.status}`);
  return res.json();
}

export const api = {
  projects: () => j<ProjectInfo[]>("/api/projects"),
  projectTree: (name: string, fresh = false) =>
    j<ProjectTree>(`/api/projects/${encodeURIComponent(name)}/tree${fresh ? "?fresh=1" : ""}`),
  projectStack: (name: string) =>
    j<ProjectStack>(`/api/projects/${encodeURIComponent(name)}/stack`),
  sessions: () => j<SessionInfo[]>("/api/sessions"),
  sessionAlive: (id: string) =>
    j<{ alive: boolean }>(`/api/sessions/${encodeURIComponent(id)}/alive`),
  harnesses: () => j<HarnessMeta[]>("/api/harnesses"),
  createSession: (project: string, name: string, harness: HarnessId) =>
    j<{ id: string }>("/api/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ project, name, harness }),
    }),
  chatSessions: (project: string) =>
    j<ChatSession[]>(`/api/chat/sessions?project=${encodeURIComponent(project)}`),
  createChatSession: (input: {
    project: string; name: string; harness: ChatHarness; model: ChatModel;
    effort: ChatEffort; permissionMode: ChatPermissionMode;
  }) => j<ChatSession>("/api/chat/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  }),
  deleteChatSession: (id: string) =>
    j<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setCodexMode: (mode: CodexMode) =>
    j<{ mode: CodexMode; configText: string }>("/api/codex/mode", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mode }),
    }),
  killSession: (id: string) =>
    j<{ ok: boolean }>(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  usage: () => j<Usage>("/api/usage"),
  greeting: () => j<Greeting>("/api/greeting"),
  news: () => j<News>("/api/news"),
  updates: (force = false) => j<Updates>(`/api/updates${force ? "?refresh=1" : ""}`),
  applyUpdate: (harness: HarnessId) => j<UpdateJob>(`/api/updates/apply?harness=${harness}`, { method: "POST" }),
  appConfig: () => j<AppConfig>("/api/config/app"),
  saveAppConfig: (cfg: Partial<AppConfig>) =>
    j<AppConfig>("/api/config/app", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cfg),
    }),
  settingsText: (harness: HarnessId) =>
    fetch(`/api/config/settings?harness=${harness}`).then(r => r.text()),
  saveSettingsText: (harness: HarnessId, text: string) =>
    j<{ ok: boolean }>(`/api/config/settings?harness=${harness}`, { method: "PUT", body: text }),
  md: (harness: HarnessId) => fetch(`/api/config/md?harness=${harness}`).then(r => r.text()),
  saveMd: (harness: HarnessId, text: string) =>
    j<{ ok: boolean }>(`/api/config/md?harness=${harness}`, { method: "PUT", body: text }),
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
  syncSkill: (name: string, to: HarnessId) =>
    j<{ ok: boolean }>(`/api/skills/${encodeURIComponent(name)}/sync`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ to }),
    }),
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

import { api, type Greeting, type HarnessMeta, type ProjectInfo, type SessionInfo, type UpdateStatus, type Usage } from "./api";
import { chime } from "./sound";

/** Fallback until GET /api/harnesses answers, so pickers render immediately. */
const DEFAULT_HARNESSES: HarnessMeta[] = [
  { id: "claude", label: "Claude", mdLabel: "~/.claude/CLAUDE.md", settingsLabel: "~/.claude/settings.json", settingsFormat: "json" },
  { id: "codex", label: "Codex", mdLabel: "~/.codex/AGENTS.md", settingsLabel: "~/.codex/config.toml", settingsFormat: "toml" },
];

export const app = $state({
  route: parseRoute(location.hash),
  projects: [] as ProjectInfo[],
  sessions: [] as SessionInfo[],
  harnesses: DEFAULT_HARNESSES,
  usage: null as Usage | null,
  greeting: null as Greeting | null,
  update: null as UpdateStatus | null,
  updateChecking: false,
  jobDisplayUntil: null as number | null, // finished-update chip retires at this time
  railExpanded: false,
  lastProject: localStorage.getItem("cc-last-project"),
});

export type Route =
  | { view: "dash" }
  | { view: "project"; name: string; session?: string }
  | { view: "skills"; name?: string }
  | { view: "config" };

function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "project" && parts[1]) return { view: "project", name: parts[1], session: parts[2] };
  if (parts[0] === "skills") return { view: "skills", name: parts[1] };
  if (parts[0] === "config") return { view: "config" };
  return { view: "dash" };
}

function rememberProject(route: Route) {
  if (route.view === "project") {
    app.lastProject = route.name;
    localStorage.setItem("cc-last-project", route.name);
  }
}

export function navigate(route: Route) {
  app.route = route;
  rememberProject(route);
  const hash =
    route.view === "project"
      ? `#/project/${encodeURIComponent(route.name)}${route.session ? "/" + encodeURIComponent(route.session) : ""}`
      : route.view === "skills" && route.name
        ? `#/skills/${encodeURIComponent(route.name)}`
        : route.view === "dash" ? "#/" : `#/${route.view}`;
  history.replaceState(null, "", hash);
}

window.addEventListener("hashchange", () => {
  app.route = parseRoute(location.hash);
  rememberProject(app.route);
});

/** Open the last active project, falling back to the busiest/first one. */
export function gotoProjects() {
  const name =
    (app.lastProject && app.projects.some(p => p.name === app.lastProject) && app.lastProject)
    || app.sessions[0]?.project
    || app.projects[0]?.name;
  if (name) navigate({ view: "project", name });
}

const THEMES = ["", "crimson", "aero"];
export function toggleTheme() {
  const r = document.documentElement;
  const cur = r.getAttribute("data-theme") ?? "";
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length];
  r.setAttribute("data-theme", next);
  localStorage.setItem("cc-theme", next);
}

/** A project's sessions in stable tab order: creation time, not activity.
    (The server sorts by activity for the dashboard, which would make tabs
    reshuffle on every poll; id tie-breaks same-second creations.) */
export function projectSessions(project: string): SessionInfo[] {
  return app.sessions
    .filter(s => s.project === project)
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id));
}

/** Is this session's terminal on screen right now? (No chime for what
    the user is already watching.) */
function isOnScreen(s: SessionInfo): boolean {
  if (document.hidden) return false;
  const r = app.route;
  if (r.view !== "project" || r.name !== s.project) return false;
  const mine = projectSessions(s.project);
  const activeId = r.session && mine.some(x => x.id === r.session) ? r.session : mine[0]?.id;
  return activeId === s.id;
}

export async function refreshCore() {
  try {
    const [projects, sessions] = await Promise.all([api.projects(), api.sessions()]);
    const prev = new Map(app.sessions.map(s => [s.id, s.status]));
    app.projects = projects;
    app.sessions = sessions;
    // chime when a session stops working while not being watched; if several
    // land in one poll, a question outranks a completion — one sound, not a chord
    const stopped = sessions.filter(s =>
      prev.get(s.id) === "working" && s.status !== "working" && !isOnScreen(s));
    if (stopped.length > 0) {
      chime(stopped.some(s => s.status === "waiting") ? "question" : "done");
    }
  } catch (e) {
    console.error("refreshCore", e);
  }
}

export async function refreshUsage() {
  try {
    const next = await api.usage();
    // Keep the last good half when one side fails (comes back null): blanking
    // it would zero the bars and unmount the burn chart, then re-animate
    // everything from scratch on the next good poll.
    app.usage = {
      limits: next.limits ?? app.usage?.limits ?? null,
      month: next.month ?? app.usage?.month ?? null,
      codex: next.codex
        ? {
            mode: next.codex.mode,
            providerName: next.codex.providerName ?? app.usage?.codex?.providerName ?? null,
            limits: next.codex.limits ?? app.usage?.codex?.limits ?? null,
            month: next.codex.month ?? app.usage?.codex?.month ?? null,
            spend: next.codex.spend ?? app.usage?.codex?.spend ?? null,
          }
        : app.usage?.codex ?? null,
      errors: next.errors,
    };
  } catch (e) { console.error("refreshUsage", e); }
}

export async function refreshGreeting() {
  try { app.greeting = await api.greeting(); } catch (e) { console.error("refreshGreeting", e); }
}

/** How long a finished `claude update` stays on the chip before it falls back
    to the plain version line. */
export const JOB_DISPLAY_MS = 5 * 60_000;

let updateWatch: ReturnType<typeof setInterval> | null = null;
let jobExpiry: ReturnType<typeof setTimeout> | null = null;

/** A finished job outranks the resting state on the chip, but only for a while.
    The deadline lives in reactive state rather than in a `Date.now()` comparison
    in the view: that expression never re-evaluates on its own, so the chip would
    hold "Updated"/"Update failed" until something else happened to change. The
    timer clears it locally, so the chip still retires on schedule even if the
    accompanying re-check fails. Reloading the page mid-window lands here too,
    since the server keeps serving the finished job. */
function armJobDisplay(finishedAt: number | null) {
  if (jobExpiry) { clearTimeout(jobExpiry); jobExpiry = null; }
  const until = finishedAt === null ? null : finishedAt + JOB_DISPLAY_MS;
  if (until === null || until <= Date.now()) {
    app.jobDisplayUntil = null;
    return;
  }
  app.jobDisplayUntil = until;
  jobExpiry = setTimeout(() => {
    jobExpiry = null;
    app.jobDisplayUntil = null; // retires the chip whether or not this succeeds
    refreshUpdate();
  }, until - Date.now());
}

/** While `claude update` runs, poll fast enough that the widget feels live;
    stop as soon as it finishes so the idle dashboard stays quiet. */
function watchUpdateJob() {
  if (updateWatch) return;
  updateWatch = setInterval(async () => {
    await refreshUpdate();
    if (app.update?.job?.status !== "running") {
      clearInterval(updateWatch!);
      updateWatch = null;
    }
  }, 2_000);
}

/** `force` re-checks now (the manual refresh); otherwise the server's 30m
    cache answers. The spinner is held a beat so a cache hit still reads as
    "something happened". */
export async function refreshUpdate(force = false) {
  if (force) {
    if (app.updateChecking) return;
    app.updateChecking = true;
  }
  const startedAt = Date.now();
  try {
    app.update = await api.updates(force);
    const job = app.update.job;
    if (job?.status === "running") watchUpdateJob();
    else armJobDisplay(job?.finishedAt ?? null);
  } catch (e) {
    console.error("refreshUpdate", e);
  } finally {
    if (force) {
      const elapsed = Date.now() - startedAt;
      if (elapsed < 450) await new Promise(r => setTimeout(r, 450 - elapsed));
      app.updateChecking = false;
    }
  }
}

export async function applyUpdate() {
  if (app.update?.job?.status === "running") return;
  try {
    const job = await api.applyUpdate();
    if (app.update) app.update = { ...app.update, job };
    armJobDisplay(null); // a new run supersedes the previous outcome
    watchUpdateJob();
  } catch (e) { console.error("applyUpdate", e); }
}

export function startPolling() {
  rememberProject(app.route);
  api.harnesses().then(h => { if (h.length) app.harnesses = h; }).catch(console.error);
  refreshCore(); refreshUsage(); refreshGreeting(); refreshUpdate();
  setInterval(refreshCore, 5_000);
  setInterval(refreshUsage, 30_000); // server caches at 60s; 30s halves worst-case lag
  setInterval(refreshGreeting, 15 * 60_000);
  setInterval(() => refreshUpdate(), 30 * 60_000);
  // returning to the tab (throttled timers) → catch up immediately
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshCore(); refreshUsage(); }
  });
}

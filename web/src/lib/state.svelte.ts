import { api, type Greeting, type ProjectInfo, type SessionInfo, type Usage } from "./api";
import { chime } from "./sound";

export const app = $state({
  route: parseRoute(location.hash),
  projects: [] as ProjectInfo[],
  sessions: [] as SessionInfo[],
  usage: null as Usage | null,
  greeting: null as Greeting | null,
  railExpanded: false,
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

export function navigate(route: Route) {
  app.route = route;
  const hash =
    route.view === "project"
      ? `#/project/${encodeURIComponent(route.name)}${route.session ? "/" + encodeURIComponent(route.session) : ""}`
      : route.view === "skills" && route.name
        ? `#/skills/${encodeURIComponent(route.name)}`
        : route.view === "dash" ? "#/" : `#/${route.view}`;
  history.replaceState(null, "", hash);
}

window.addEventListener("hashchange", () => { app.route = parseRoute(location.hash); });

export function toggleTheme() {
  const r = document.documentElement;
  const next = r.getAttribute("data-theme") === "crimson" ? "" : "crimson";
  r.setAttribute("data-theme", next);
  localStorage.setItem("cc-theme", next);
}

/** Is this session's terminal on screen right now? (No chime for what
    the user is already watching.) */
function isOnScreen(s: SessionInfo): boolean {
  if (document.hidden) return false;
  const r = app.route;
  if (r.view !== "project" || r.name !== s.project) return false;
  const mine = app.sessions.filter(x => x.project === s.project);
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
  try { app.usage = await api.usage(); } catch (e) { console.error("refreshUsage", e); }
}

export async function refreshGreeting() {
  try { app.greeting = await api.greeting(); } catch (e) { console.error("refreshGreeting", e); }
}

export function startPolling() {
  refreshCore(); refreshUsage(); refreshGreeting();
  setInterval(refreshCore, 5_000);
  setInterval(refreshUsage, 30_000); // server caches at 60s; 30s halves worst-case lag
  setInterval(refreshGreeting, 15 * 60_000);
  // returning to the tab (throttled timers) → catch up immediately
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) { refreshCore(); refreshUsage(); }
  });
}

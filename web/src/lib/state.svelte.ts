import { api, type Greeting, type ProjectInfo, type SessionInfo, type Usage } from "./api";

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

export async function refreshCore() {
  try {
    const [projects, sessions] = await Promise.all([api.projects(), api.sessions()]);
    app.projects = projects;
    app.sessions = sessions;
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
  setInterval(refreshUsage, 60_000);
  setInterval(refreshGreeting, 15 * 60_000);
}

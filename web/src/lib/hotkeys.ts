import { app, navigate, gotoProjects, projectWorkspace } from "../stores/state.svelte";
import { triggerSlopmaxx } from "../components/pets/mascot";
import { cycle } from "../utils/cycle";

// ⌃1 dashboard · ⌃2 projects (last active; press again to cycle, ⌃⇧2 backward)
// ⌃3 skills · ⌃4 config · ⌃⇧[ / ⌃⇧] prev/next visible session tab · ⌃⇧S slopmaxx the mascot.
// Ctrl-combos deliberately: they reach us even with the terminal focused, and
// neither macOS nor the browser reserves them (⌘1… switches browser tabs,
// ⌃[ is ESC — both untouchable).

function cycleProject(dir: 1 | -1) {
  const route = app.route;
  if (route.view !== "project" || app.projects.length === 0) return;
  navigate({ view: "project", name: cycle(app.projects.map(p => p.name), route.name, dir) });
}

function cycleSession(dir: 1 | -1) {
  const route = app.route;
  if (route.view !== "project") return;
  const { sessions, activeId } = projectWorkspace(route.name);
  if (sessions.length < 2 || !activeId) return;
  navigate({ view: "project", name: route.name, session: cycle(sessions.map(s => s.id), activeId, dir) });
}

function handle(e: KeyboardEvent): boolean {
  const digit = /^Digit([1-4])$/.exec(e.code)?.[1];
  if (digit === "2") {
    if (app.route.view === "project") cycleProject(e.shiftKey ? -1 : 1);
    else gotoProjects();
    return true;
  }
  if (e.shiftKey) {
    if (e.code === "BracketRight") { cycleSession(1); return true; }
    if (e.code === "BracketLeft") { cycleSession(-1); return true; }
    if (e.code === "KeyS") return triggerSlopmaxx();
    return false;
  }
  if (digit === "1") { navigate({ view: "dash" }); return true; }
  if (digit === "3") { navigate({ view: "skills" }); return true; }
  if (digit === "4") { navigate({ view: "config" }); return true; }
  return false;
}

let installed = false;

export function installHotkeys() {
  if (installed) return;
  installed = true;
  // capture phase: fire ahead of xterm's own key handling
  window.addEventListener("keydown", (e) => {
    if (!e.ctrlKey || e.metaKey || e.altKey) return;
    if (handle(e)) { e.preventDefault(); e.stopPropagation(); }
  }, { capture: true });
}

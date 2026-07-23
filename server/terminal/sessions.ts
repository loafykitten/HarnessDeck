import { homedir } from "node:os";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_HARNESS, HARNESSES, isHarnessId, type HarnessId } from "../harness/registry";
import {
  addSessionRegistryEntry,
  readSessionRegistry,
  removeSessionRegistryEntries,
  syncSessionRegistry,
  type PersistedSession,
} from "./persistence";

const PREFIX = "cc-";
const SEP = "--";
export const DEV_DIR = join(homedir(), "Developer");

export type SessionStatus = "working" | "waiting" | "idle";

export interface Session {
  id: string;
  project: string;
  name: string;
  harness: HarnessId;
  created: number;
  activity: number;
  attached: number;
  status: SessionStatus;
}

export async function tmux(...args: string[]): Promise<{ ok: boolean; out: string; err: string }> {
  const p = Bun.spawn(["tmux", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  const code = await p.exited;
  return { ok: code === 0, out, err };
}

let clipboardConfigured = false;
async function ensureClipboard(): Promise<void> {
  if (clipboardConfigured) return;
  const clipboard = await tmux("set-option", "-s", "set-clipboard", "on");
  if (!clipboard.ok) return; // no tmux server yet
  const features = await tmux(
    "set-option", "-as", "terminal-features", "xterm-256color:clipboard",
  );
  if (features.ok) clipboardConfigured = true;
}

async function startTmuxSession(id: string, dir: string, command: string): Promise<{ ok: boolean; error: string }> {
  // Login + interactive zsh sources ~/.zprofile and ~/.zshrc, so the agent
  // inherits the user's env vars. exec makes the tmux session end with it.
  const res = await tmux(
    "new-session", "-d", "-s", id, "-c", dir, "-x", "220", "-y", "50",
    "zsh", "-lic", `exec ${command}`,
  );
  if (!res.ok) return { ok: false, error: res.err.trim() || "tmux new-session failed" };
  await ensureClipboard();
  // no '=' prefix: set-option's -t is a pane-style target that rejects it
  await tmux("set-option", "-t", `${id}:`, "status", "off");
  invalidateSessionCaches();
  return { ok: true, error: "" };
}

function sanitize(s: string): string {
  // tmux session names cannot contain ':' or '.'; keep it shell-friendly too
  return s.replace(/[^a-zA-Z0-9_-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
}

/** Sanitized names can never contain "--" (runs of '-' collapse), so SEP
    splits are unambiguous. Claude ids stay two-segment (`cc-proj--name`) for
    compatibility with sessions created before harnesses existed; any other
    harness appends its id as a third segment (`cc-proj--name--codex`). */
export function sessionId(project: string, name: string, harness: HarnessId): string {
  const base = `${PREFIX}${sanitize(project)}${SEP}${sanitize(name)}`;
  return harness === DEFAULT_HARNESS ? base : `${base}${SEP}${harness}`;
}

/** Classify a session from its visible pane. Each harness paints a transient
    spinner line with an elapsed-time timer while running, and numbered ❯
    options when it's waiting on a human answer; the bare "❯" input prompt is
    always on screen, so waiting must match the option list, not the prompt.
    Working is checked first: stale question text can linger in the visible
    scrollback. */
async function sessionStatus(id: string, harness: HarnessId): Promise<SessionStatus> {
  const res = await tmux("capture-pane", "-p", "-t", `${id}:`);
  if (!res.ok) return "idle";
  const h = HARNESSES[harness];
  const tail = res.out.trimEnd().split("\n").slice(-30).join("\n");
  if (h.working.test(tail)) return "working";
  if (h.waiting.test(tail)) return "waiting";
  return "idle";
}

const SESSION_CACHE_TTL = 1_750;
let sessionCacheGeneration = 0;
let baseCache: { at: number; data: Session[] } | null = null;
let baseInFlight: Promise<Session[]> | null = null;
let statusCache: { at: number; data: Session[] } | null = null;
let statusInFlight: Promise<Session[]> | null = null;

function invalidateSessionCaches(): void {
  sessionCacheGeneration += 1;
  baseCache = null;
  baseInFlight = null;
  statusCache = null;
  statusInFlight = null;
}

async function computeBaseSessions(): Promise<Session[]> {
  // '|' separator: tmux mangles control chars (like \t) into '_' in -F output,
  // and '|' can never appear in our sanitized session names
  const { ok, out } = await tmux(
    "list-sessions", "-F",
    "#{session_name}|#{session_created}|#{session_activity}|#{session_attached}",
  );
  if (!ok) return []; // tmux server not running = no sessions; never prune here
  const sessions: Session[] = [];
  for (const line of out.trim().split("\n")) {
    if (!line) continue;
    const [id, created, activity, attached] = line.split("|");
    if (!id?.startsWith(PREFIX)) continue;
    const parts = id.slice(PREFIX.length).split(SEP);
    const last = parts[parts.length - 1];
    const harness = parts.length >= 3 && isHarnessId(last) ? last : DEFAULT_HARNESS;
    const nameParts = harness === DEFAULT_HARNESS ? parts.slice(1) : parts.slice(1, -1);
    sessions.push({
      id,
      project: parts[0],
      name: nameParts.join(SEP) || "main",
      harness,
      created: Number(created) * 1000,
      activity: Number(activity) * 1000,
      attached: Number(attached),
      status: "idle",
    });
  }
  sessions.sort((a, b) => b.activity - a.activity);
  if (!reconciliationInProgress) {
    const live = sessions.map(({ id, project, name, harness, created }) =>
      ({ id, project, name, harness, created }));
    try {
      await syncSessionRegistry(live, recentlyRecreatedIds());
    } catch (error) {
      console.error("sync session registry", error);
    }
  }
  return sessions;
}

export async function listSessionsBase(): Promise<Session[]> {
  if (baseCache && Date.now() - baseCache.at < SESSION_CACHE_TTL) return baseCache.data;
  if (baseInFlight) return baseInFlight;
  const generation = sessionCacheGeneration;
  const pending = computeBaseSessions().then(data => {
    if (generation === sessionCacheGeneration) baseCache = { at: Date.now(), data };
    return data;
  });
  baseInFlight = pending;
  const clear = () => { if (baseInFlight === pending) baseInFlight = null; };
  pending.then(clear, clear);
  return pending;
}

export async function listSessions(): Promise<Session[]> {
  if (statusCache && Date.now() - statusCache.at < SESSION_CACHE_TTL) return statusCache.data;
  if (statusInFlight) return statusInFlight;
  const generation = sessionCacheGeneration;
  const pending = (async () => {
    const sessions = await listSessionsBase();
    const statuses = await Promise.all(sessions.map(s => sessionStatus(s.id, s.harness)));
    const data = sessions.map((session, i) => ({ ...session, status: statuses[i] }));
    if (generation === sessionCacheGeneration) statusCache = { at: Date.now(), data };
    return data;
  })();
  statusInFlight = pending;
  const clear = () => { if (statusInFlight === pending) statusInFlight = null; };
  pending.then(clear, clear);
  return pending;
}

export async function createSession(project: string, name: string, harness: HarnessId = DEFAULT_HARNESS): Promise<{ id: string } | { error: string }> {
  const dir = join(DEV_DIR, project);
  try {
    const st = await stat(dir);
    if (!st.isDirectory()) return { error: `not a directory: ${dir}` };
  } catch {
    return { error: `no such project: ${project}` };
  }
  const id = sessionId(project, name, harness);
  const existing = await tmux("has-session", "-t", `=${id}`);
  if (existing.ok) return { error: `session already exists: ${id}` };
  const started = await startTmuxSession(id, dir, HARNESSES[harness].bin);
  if (!started.ok) return { error: started.error };
  await addSessionRegistryEntry({ id, project, name, harness, created: Date.now() });
  return { id };
}

export async function killSession(id: string): Promise<boolean> {
  if (!id.startsWith(PREFIX)) return false;
  const res = await tmux("kill-session", "-t", `=${id}`);
  if (res.ok) {
    invalidateSessionCaches();
    await removeSessionRegistryEntries([id]);
  }
  return res.ok;
}

const RECREATED_PROTECTION_MS = 10_000;
const recentlyRecreated = new Map<string, number>();
let reconciliationInProgress = false;

function recentlyRecreatedIds(): Set<string> {
  const now = Date.now();
  const ids = new Set<string>();
  for (const [id, recreatedAt] of recentlyRecreated) {
    if (now - recreatedAt < RECREATED_PROTECTION_MS) ids.add(id);
    else recentlyRecreated.delete(id);
  }
  return ids;
}

async function isProjectDirectory(dir: string): Promise<boolean> {
  try { return (await stat(dir)).isDirectory(); } catch { return false; }
}

function isValidRegistryEntry(entry: PersistedSession): boolean {
  return entry.id === sessionId(entry.project, entry.name, entry.harness);
}

export async function reconcilePersistedSessions(): Promise<void> {
  reconciliationInProgress = true;
  let restored = 0;
  let running = 0;
  let dropped = 0;
  let failed = 0;
  try {
    const entries = await readSessionRegistry();
    const dropIds = new Set<string>();
    const restorable: PersistedSession[] = [];
    for (const entry of entries) {
      const dir = join(DEV_DIR, entry.project);
      if (!isValidRegistryEntry(entry) || !(await isProjectDirectory(dir))) {
        dropIds.add(entry.id);
        dropped += 1;
      } else {
        restorable.push(entry);
      }
    }
    await removeSessionRegistryEntries(dropIds);

    const projectHarnessCounts = new Map<string, number>();
    for (const entry of restorable) {
      const key = `${entry.project}\0${entry.harness}`;
      projectHarnessCounts.set(key, (projectHarnessCounts.get(key) ?? 0) + 1);
    }

    for (const entry of restorable) {
      if ((await tmux("has-session", "-t", `=${entry.id}`)).ok) {
        running += 1;
        continue;
      }
      const key = `${entry.project}\0${entry.harness}`;
      const harness = HARNESSES[entry.harness];
      const command = projectHarnessCounts.get(key) === 1 ? harness.resumeLast : harness.resumePick;
      const result = await startTmuxSession(entry.id, join(DEV_DIR, entry.project), command);
      if (result.ok) {
        recentlyRecreated.set(entry.id, Date.now());
        restored += 1;
      } else {
        failed += 1;
        console.error(`restore session ${entry.id}: ${result.error}`);
      }
    }
  } finally {
    reconciliationInProgress = false;
  }
  console.log(`Sessions: restored ${restored}, already running ${running}, dropped ${dropped}, failed ${failed}`);
}

export async function hasSession(id: string): Promise<boolean> {
  return (await tmux("has-session", "-t", `=${id}`)).ok;
}

/** Type text into the session's input (no Enter), e.g. a pasted-image path.
    NB: send-keys takes a pane-style target — the '=' exact prefix is rejected. */
export async function typeIntoSession(id: string, text: string): Promise<boolean> {
  if (!id.startsWith(PREFIX)) return false;
  const res = await tmux("send-keys", "-t", `${id}:`, "-l", text);
  return res.ok;
}

/** Insert a newline into claude's input box without submitting: a pane-side
    bracketed paste of "\n". (Client-side paste brackets get mangled by tmux's
    attach-client input parsing — pane-side injection is the reliable path.) */
export async function newlineIntoSession(id: string): Promise<boolean> {
  if (!id.startsWith(PREFIX)) return false;
  const res = await tmux("send-keys", "-t", `${id}:`, "-H",
    "1b", "5b", "32", "30", "30", "7e", "0a", "1b", "5b", "32", "30", "31", "7e");
  return res.ok;
}

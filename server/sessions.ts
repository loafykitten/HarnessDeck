import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_HARNESS, HARNESSES, isHarnessId, type HarnessId } from "./harnesses";

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

export async function listSessions(): Promise<Session[]> {
  // '|' separator: tmux mangles control chars (like \t) into '_' in -F output,
  // and '|' can never appear in our sanitized session names
  const { ok, out } = await tmux(
    "list-sessions", "-F",
    "#{session_name}|#{session_created}|#{session_activity}|#{session_attached}",
  );
  if (!ok) return []; // tmux server not running = no sessions
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
  const statuses = await Promise.all(sessions.map(s => sessionStatus(s.id, s.harness)));
  sessions.forEach((s, i) => { s.status = statuses[i]; });
  sessions.sort((a, b) => b.activity - a.activity);
  return sessions;
}

export async function createSession(project: string, name: string, harness: HarnessId = DEFAULT_HARNESS): Promise<{ id: string } | { error: string }> {
  const dir = join(DEV_DIR, project);
  try {
    const st = await import("node:fs/promises").then(fs => fs.stat(dir));
    if (!st.isDirectory()) return { error: `not a directory: ${dir}` };
  } catch {
    return { error: `no such project: ${project}` };
  }
  const id = sessionId(project, name, harness);
  const existing = await tmux("has-session", "-t", `=${id}`);
  if (existing.ok) return { error: `session already exists: ${id}` };
  // Login + interactive zsh (sources ~/.zprofile and ~/.zshrc, so the agent
  // inherits the user's env vars) that execs the harness binary: when it
  // exits, the shell — and with it the session — ends.
  const res = await tmux(
    "new-session", "-d", "-s", id, "-c", dir, "-x", "220", "-y", "50",
    "zsh", "-lic", `exec ${HARNESSES[harness].bin}`,
  );
  if (!res.ok) return { error: res.err.trim() || "tmux new-session failed" };
  // no '=' prefix: set-option's -t is a pane-style target that rejects it
  await tmux("set-option", "-t", `${id}:`, "status", "off");
  return { id };
}

export async function killSession(id: string): Promise<boolean> {
  if (!id.startsWith(PREFIX)) return false;
  const res = await tmux("kill-session", "-t", `=${id}`);
  return res.ok;
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

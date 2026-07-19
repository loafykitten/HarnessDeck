import { homedir } from "node:os";
import { join } from "node:path";

const PREFIX = "cc-";
const SEP = "--";
export const DEV_DIR = join(homedir(), "Developer");

export interface Session {
  id: string;
  project: string;
  name: string;
  created: number;
  activity: number;
  attached: number;
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

export function sessionId(project: string, name: string): string {
  return `${PREFIX}${sanitize(project)}${SEP}${sanitize(name)}`;
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
    const rest = id.slice(PREFIX.length);
    const i = rest.indexOf(SEP);
    sessions.push({
      id,
      project: i === -1 ? rest : rest.slice(0, i),
      name: i === -1 ? "main" : rest.slice(i + SEP.length),
      created: Number(created) * 1000,
      activity: Number(activity) * 1000,
      attached: Number(attached),
    });
  }
  sessions.sort((a, b) => b.activity - a.activity);
  return sessions;
}

const CLAUDE_BIN = join(homedir(), ".local", "bin", "claude");

export async function createSession(project: string, name: string): Promise<{ id: string } | { error: string }> {
  const dir = join(DEV_DIR, project);
  try {
    const st = await import("node:fs/promises").then(fs => fs.stat(dir));
    if (!st.isDirectory()) return { error: `not a directory: ${dir}` };
  } catch {
    return { error: `no such project: ${project}` };
  }
  const id = sessionId(project, name);
  const existing = await tmux("has-session", "-t", `=${id}`);
  if (existing.ok) return { error: `session already exists: ${id}` };
  // Session runs claude directly: when claude exits, the session ends.
  const res = await tmux(
    "new-session", "-d", "-s", id, "-c", dir, "-x", "220", "-y", "50", CLAUDE_BIN,
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

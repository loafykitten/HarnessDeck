import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { claudeChatDriver } from "./claude";
import type {
  ChatEffort,
  ChatHandle,
  ChatModel,
  ChatOptions,
  ChatPermissionMode,
  ChatStatus,
  DriverEvent,
  PermissionResponse,
  QuestionResponse,
} from "./driver";

const DEV_DIR = join(homedir(), "Developer");
const STORE_DIR = join(homedir(), ".config", "harnessdeck");
const PORT = Number(process.env.PORT) || 4553;
const STORE_PATH = join(STORE_DIR, PORT === 4553 ? "chat-sessions.json" : `chat-sessions-${PORT}.json`);
const MAX_EVENTS = 500;

export type ChatHarness = "claude";
export type ChatEvent = DriverEvent & { seq: number };

export interface ChatSession {
  id: string;
  project: string;
  name: string;
  harness: ChatHarness;
  model: ChatModel;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
  canBypassPermissions: boolean;
  sdkSessionId: string | null;
  status: ChatStatus;
  costUsd: number;
  created: number;
  lastActivity: number;
}

type StoredSession = ChatSession & { seq?: number };
type InternalSession = ChatSession & {
  handle: ChatHandle | null;
  events: ChatEvent[];
  seq: number;
  listeners: Set<(event: ChatEvent) => void>;
};

const sessions = new Map<string, InternalSession>();
let loaded = false;
let loadPromise: Promise<void> | null = null;
let persistChain = Promise.resolve();

const view = (session: InternalSession): ChatSession => ({
  id: session.id,
  project: session.project,
  name: session.name,
  harness: session.harness,
  model: session.model,
  effort: session.effort,
  permissionMode: session.permissionMode,
  canBypassPermissions: session.canBypassPermissions,
  sdkSessionId: session.sdkSessionId,
  status: session.status,
  costUsd: session.costUsd,
  created: session.created,
  lastActivity: session.lastActivity,
});

async function loadSessions(): Promise<void> {
  if (loaded) return;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const stored = JSON.parse(await readFile(STORE_PATH, "utf8")) as StoredSession[];
      for (const item of stored) {
        if (!item?.id?.startsWith("chat-") || item.harness !== "claude") continue;
        sessions.set(item.id, {
          ...item,
          status: "idle",
          costUsd: item.costUsd ?? 0,
          canBypassPermissions: item.canBypassPermissions ?? item.permissionMode === "bypassPermissions",
          handle: null,
          events: [],
          seq: Number.isSafeInteger(item.seq) && (item.seq ?? 0) >= 0 ? item.seq! : 0,
          listeners: new Set(),
        });
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") console.error("load chat sessions", error);
    }
    loaded = true;
  })();
  return loadPromise;
}

function persist(): Promise<void> {
  persistChain = persistChain.then(async () => {
    await mkdir(STORE_DIR, { recursive: true });
    const tmp = `${STORE_PATH}.tmp-${process.pid}`;
    const data: StoredSession[] = [...sessions.values()].map(session => ({
      ...view(session),
      seq: session.seq,
    }));
    await writeFile(tmp, JSON.stringify(data, null, 2) + "\n");
    await rename(tmp, STORE_PATH);
  }).catch(error => console.error("persist chat sessions", error));
  return persistChain;
}

function emit(session: InternalSession, event: DriverEvent): void {
  const next = { ...event, seq: ++session.seq } as ChatEvent;
  session.lastActivity = Date.now();
  if (event.type === "status") session.status = event.status;
  if (event.type === "result") session.costUsd = event.costUsd;
  session.events.push(next);
  if (session.events.length > MAX_EVENTS) session.events.splice(0, session.events.length - MAX_EVENTS);
  for (const listener of session.listeners) listener(next);
  if (event.type === "status" || event.type === "result") void persist();
}

function ensureHandle(session: InternalSession): ChatHandle {
  if (session.handle) return session.handle;
  const handle = claudeChatDriver.start({
    cwd: join(DEV_DIR, session.project),
    model: session.model,
    effort: session.effort,
    permissionMode: session.permissionMode,
    canBypassPermissions: session.canBypassPermissions,
    continuationId: session.sdkSessionId ?? undefined,
    onContinuationId: id => {
      if (session.sdkSessionId === id) return;
      session.sdkSessionId = id;
      void persist();
    },
  });
  handle.onEvent(event => emit(session, event));
  session.handle = handle;
  return handle;
}

export async function listChatSessions(project?: string): Promise<ChatSession[]> {
  await loadSessions();
  return [...sessions.values()]
    .filter(session => !project || session.project === project)
    .sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
    .map(view);
}

export async function createChatSession(input: {
  project: string;
  name: string;
  harness: ChatHarness;
  model: ChatModel;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
}): Promise<ChatSession> {
  await loadSessions();
  if (!input.project || input.project === "." || input.project === ".." || input.project !== basename(input.project)) {
    throw new Error("invalid project");
  }
  const projectDir = join(DEV_DIR, input.project);
  const resolvedProjectDir = await realpath(projectDir).catch(() => null);
  const resolvedDevDir = await realpath(DEV_DIR).catch(() => null);
  if (!resolvedProjectDir || !resolvedDevDir || dirname(resolvedProjectDir) !== resolvedDevDir) {
    throw new Error("invalid project");
  }
  const info = await stat(resolvedProjectDir).catch(() => null);
  if (!info?.isDirectory()) throw new Error(`no such project: ${input.project}`);
  const now = Date.now();
  const session: InternalSession = {
    id: `chat-${randomUUID()}`,
    ...input,
    canBypassPermissions: input.permissionMode === "bypassPermissions",
    sdkSessionId: null,
    status: "idle",
    costUsd: 0,
    created: now,
    lastActivity: now,
    handle: null,
    events: [],
    seq: 0,
    listeners: new Set(),
  };
  sessions.set(session.id, session);
  await persist();
  return view(session);
}

export async function hasChatSession(id: string): Promise<boolean> {
  await loadSessions();
  return sessions.has(id);
}

export function chatInit(id: string): { session: ChatSession; backlog: ChatEvent[]; seq: number } | null {
  const session = sessions.get(id);
  if (!session) return null;
  return { session: view(session), backlog: [...session.events], seq: session.seq };
}

export function subscribeChat(id: string, listener: (event: ChatEvent) => void): (() => void) | null {
  const session = sessions.get(id);
  if (!session) return null;
  session.listeners.add(listener);
  return () => session.listeners.delete(listener);
}

export function sendChatMessage(id: string, text: string): boolean {
  const session = sessions.get(id);
  if (!session || !text.trim()) return false;
  ensureHandle(session).send(text.trim());
  return true;
}

export function respondChatPermission(id: string, requestId: string, response: PermissionResponse): boolean {
  const session = sessions.get(id);
  if (!session?.handle) return false;
  session.handle.respondPermission(requestId, response);
  return true;
}

export function respondChatQuestion(id: string, requestId: string, response: QuestionResponse): boolean {
  const session = sessions.get(id);
  if (!session?.handle) return false;
  session.handle.respondQuestion(requestId, response);
  return true;
}

export async function setChatOptions(id: string, options: Partial<ChatOptions>): Promise<boolean> {
  const session = sessions.get(id);
  if (!session) return false;
  if (options.permissionMode === "bypassPermissions" && !session.canBypassPermissions) return false;
  if (session.handle) {
    try {
      await session.handle.setOptions(options);
    } catch (error) {
      emit(session, { type: "error", message: error instanceof Error ? error.message : String(error) });
      return false;
    }
  }
  if (options.model !== undefined) session.model = options.model;
  if (options.effort !== undefined) session.effort = options.effort;
  if (options.permissionMode !== undefined) session.permissionMode = options.permissionMode;
  await persist();
  return true;
}

export async function interruptChat(id: string): Promise<boolean> {
  const session = sessions.get(id);
  if (!session?.handle) return false;
  try {
    await session.handle.interrupt();
  } catch (error) {
    emit(session, { type: "error", message: error instanceof Error ? error.message : String(error) });
    return false;
  }
  return true;
}

export async function deleteChatSession(id: string): Promise<boolean> {
  await loadSessions();
  const session = sessions.get(id);
  if (!session) return false;
  if (session.handle) await session.handle.stop();
  sessions.delete(id);
  await persist();
  return true;
}

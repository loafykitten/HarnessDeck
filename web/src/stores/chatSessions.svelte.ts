import { api } from "../lib/api";
import type {
  ChatEffort,
  ChatHarness,
  ChatModel,
  ChatPermissionMode,
  ChatSession,
} from "../types/chat";
import { disposeChatStore } from "./chat.svelte";

export type ProjectMode = "terminal" | "chat";

type CreateChatInput = {
  name: string;
  harness: ChatHarness;
  model: ChatModel;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
};

const stores = new Map<string, ChatSessionsStore>();

function savedMode(project: string): ProjectMode {
  return localStorage.getItem(`hd-project-mode:${project}`) === "chat" ? "chat" : "terminal";
}

export class ChatSessionsStore {
  sessions = $state<ChatSession[]>([]);
  loading = $state(false);
  error = $state("");
  showForm = $state(false);
  mode = $state<ProjectMode>("terminal");
  private loaded = false;

  constructor(readonly project: string) {
    this.mode = savedMode(project);
  }

  async load(): Promise<void> {
    if (this.loaded || this.loading) return;
    this.loading = true;
    this.error = "";
    try {
      this.sessions = await api.chatSessions(this.project);
      this.loaded = true;
      if (this.sessions.length === 0) this.showForm = true;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "Could not load chats";
    } finally {
      this.loading = false;
    }
  }

  async create(input: CreateChatInput): Promise<ChatSession> {
    this.error = "";
    try {
      const session = await api.createChatSession({ project: this.project, ...input });
      this.sessions.push(session);
      return session;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "Could not create chat";
      throw cause;
    }
  }

  async remove(id: string): Promise<void> {
    this.error = "";
    try {
      await api.deleteChatSession(id);
      disposeChatStore(id);
      this.sessions = this.sessions.filter(session => session.id !== id);
      if (this.sessions.length === 0) this.showForm = true;
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : "Could not delete chat";
      throw cause;
    }
  }

  update(updated: ChatSession): void {
    const session = this.sessions.find(item => item.id === updated.id);
    if (session) Object.assign(session, updated);
  }
}

export function getChatSessionsStore(project: string): ChatSessionsStore {
  let store = stores.get(project);
  if (!store) {
    store = new ChatSessionsStore(project);
    stores.set(project, store);
  }
  return store;
}

export function projectMode(project: string): ProjectMode {
  return getChatSessionsStore(project).mode;
}

export function setProjectMode(project: string, mode: ProjectMode): void {
  const store = getChatSessionsStore(project);
  if (store.mode === mode) return;
  store.mode = mode;
  localStorage.setItem(`hd-project-mode:${project}`, mode);
}

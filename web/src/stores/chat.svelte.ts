import { chime } from "../lib/sound";
import type {
  ChatClientMessage,
  ChatEffort,
  ChatEvent,
  ChatFeedItem,
  ChatInit,
  ChatModel,
  ChatPermissionMode,
  ChatSession,
  ChatStatus,
  RequestOutcome,
} from "../types/chat";

const stores = new Map<string, ChatConnection>();
const SUSPEND_AFTER_MS = 60_000;
const REQUEST_OUTCOME_LABELS: Record<RequestOutcome, string> = {
  answered: "answered",
  allowed: "allowed",
  "always-allowed": "always allowed",
  denied: "denied",
  dismissed: "dismissed",
};

export class ChatConnection {
  feed = $state<ChatFeedItem[]>([]);
  session = $state<ChatSession | null>(null);
  status = $state<ChatStatus>("idle");
  connected = $state(false);
  reconnecting = $state(false);

  private ws: WebSocket | null = null;
  private lastSeq = 0;
  private active = false;
  private disposed = false;
  private retryDelay = 1_000;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private suspendTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private replayingInit = false;
  private inFlightStreams = new Map<string, Extract<ChatFeedItem, { type: "message" | "thinking" }>>();

  constructor(readonly sessionId: string) {}

  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      if (this.suspendTimer) { clearTimeout(this.suspendTimer); this.suspendTimer = null; }
      if (!this.ws && !this.disposed) this.connect();
    } else if (!this.suspendTimer) {
      this.suspendTimer = setTimeout(() => this.suspend(), SUSPEND_AFTER_MS);
    }
  }

  send(text: string): void {
    if (text.trim()) this.sendWs({ type: "user_message", text: text.trim() });
  }

  respondPermission(id: string, behavior: "allow" | "deny", always = false, message?: string): void {
    const item = this.feed.find(entry => entry.type === "permission" && entry.requestId === id);
    if (item?.type === "permission") item.resolved = behavior === "allow" ? (always ? "always allowed" : "allowed") : "denied";
    this.sendWs({ type: "permission_response", id, behavior, always, message });
  }

  respondQuestion(id: string, answers: Record<string, string[]>): void {
    const item = this.feed.find(entry => entry.type === "question" && entry.requestId === id);
    if (item?.type === "question") item.resolved = "answered";
    this.sendWs({ type: "question_response", id, answers });
  }

  setOptions(options: { model?: ChatModel; effort?: ChatEffort; permissionMode?: ChatPermissionMode }): void {
    if (options.permissionMode === "bypassPermissions" && !this.session?.canBypassPermissions) return;
    if (this.session) Object.assign(this.session, options);
    this.sendWs({ type: "set_options", ...options });
  }

  interrupt(): void {
    this.sendWs({ type: "interrupt" });
  }

  dispose(): void {
    this.disposed = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.suspendTimer) clearTimeout(this.suspendTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close();
    this.ws = null;
    stores.delete(this.sessionId);
  }

  private sendWs(message: ChatClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  private suspend(): void {
    this.suspendTimer = null;
    if (this.active || this.disposed) return;
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
    const socket = this.ws;
    this.ws = null;
    this.connected = false;
    this.reconnecting = false;
    socket?.close();
  }

  private connect(): void {
    if (this.disposed || !this.active || this.ws) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/chat/${encodeURIComponent(this.sessionId)}`);
    this.ws = socket;
    this.reconnecting = this.lastSeq > 0;
    socket.onopen = () => {
      if (this.ws !== socket) return;
      this.connected = true;
      this.reconnecting = false;
      this.retryDelay = 1_000;
      this.pingTimer = setInterval(() => this.sendWs({ type: "ping" }), 30_000);
    };
    socket.onmessage = event => {
      if (this.ws !== socket || typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as ChatInit | ChatEvent;
      if (message.type === "init") {
        if (message.seq < this.lastSeq) {
          this.feed.length = 0;
          this.lastSeq = 0;
          this.inFlightStreams.clear();
        }
        this.session = message.session;
        this.replayingInit = true;
        try {
          for (const backlogEvent of message.backlog) this.apply(backlogEvent);
          this.lastSeq = Math.max(this.lastSeq, message.seq);
          this.setStatus(message.session.status);
        } finally {
          this.replayingInit = false;
        }
      } else this.apply(message);
    };
    socket.onclose = () => {
      if (this.ws !== socket) return;
      this.ws = null;
      this.connected = false;
      if (this.pingTimer) { clearInterval(this.pingTimer); this.pingTimer = null; }
      if (!this.disposed && this.active) {
        this.reconnecting = true;
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.connect();
        }, this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 15_000);
      }
    };
  }

  private setStatus(status: ChatStatus): void {
    const previous = this.status;
    this.status = status;
    if (this.session) this.session.status = status;
    if (previous === "waiting" && status !== "waiting") {
      for (const item of this.feed) {
        if ((item.type === "permission" || item.type === "question") && !item.resolved) item.resolved = "dismissed";
      }
    }
    if (!this.replayingInit && previous === "working" && status !== "working" && (document.hidden || !this.active)) {
      chime(status === "waiting" ? "question" : "done");
    }
    if (status === "idle") {
      for (const item of this.feed) {
        if (item.type === "message" || item.type === "thinking") item.streaming = false;
      }
      this.inFlightStreams.clear();
    }
  }

  private apply(event: ChatEvent): void {
    if (event.seq <= this.lastSeq) return;
    this.lastSeq = event.seq;
    const id = `${event.type}-${event.seq}`;
    if (event.type === "delta") {
      const type = event.kind === "thinking" ? "thinking" : "message";
      const streamKey = event.parentToolUseId ?? "main";
      const current = this.inFlightStreams.get(streamKey);
      if (type === "message" && current?.type === "message" && current.role === "assistant" && current.streaming) {
        current.text += event.text;
      } else if (type === "thinking" && current?.type === "thinking" && current.streaming) {
        current.text += event.text;
      } else if (type === "message") {
        if (current) current.streaming = false;
        const item: Extract<ChatFeedItem, { type: "message" }> = {
          id, type, role: "assistant", text: event.text, streaming: true,
          parentToolUseId: event.parentToolUseId,
        };
        this.feed.push(item);
        this.inFlightStreams.set(streamKey, this.feed.at(-1)! as typeof item);
      } else {
        if (current) current.streaming = false;
        const item: Extract<ChatFeedItem, { type: "thinking" }> = {
          id, type, text: event.text, streaming: true, parentToolUseId: event.parentToolUseId,
        };
        this.feed.push(item);
        this.inFlightStreams.set(streamKey, this.feed.at(-1)! as typeof item);
      }
    } else if (event.type === "block") {
      const streamKey = event.parentToolUseId ?? "main";
      const current = this.inFlightStreams.get(streamKey);
      if (event.role === "assistant" && current?.type === "message" && current.role === "assistant" && current.streaming) {
        current.text = event.content;
        current.streaming = false;
        this.inFlightStreams.delete(streamKey);
      } else {
        if (event.role === "assistant" && current) {
          current.streaming = false;
          this.inFlightStreams.delete(streamKey);
        }
        this.feed.push({ id, type: "message", role: event.role, text: event.content, parentToolUseId: event.parentToolUseId });
      }
    } else if (event.type === "tool") {
      const existing = this.feed.find(item => item.type === "tool" && item.toolId === event.id);
      if (event.phase === "start") {
        if (!existing) this.feed.push({ id, type: "tool", toolId: event.id, name: event.name, input: event.input, running: true, parentToolUseId: event.parentToolUseId });
      } else if (existing?.type === "tool") {
        existing.running = false;
        existing.result = event.result;
        existing.isError = event.isError;
      } else {
        this.feed.push({ id, type: "tool", toolId: event.id, name: event.name, result: event.result, isError: event.isError, running: false, parentToolUseId: event.parentToolUseId });
      }
    } else if (event.type === "permission_request") {
      if (!this.feed.some(item => item.type === "permission" && item.requestId === event.id)) {
        this.feed.push({ id, type: "permission", requestId: event.id, toolName: event.toolName, input: event.input });
      }
    } else if (event.type === "question_request") {
      if (!this.feed.some(item => item.type === "question" && item.requestId === event.id)) {
        this.feed.push({ id, type: "question", requestId: event.id, questions: event.questions });
      }
    } else if (event.type === "request_resolved") {
      const item = this.feed.find(entry =>
        (entry.type === "permission" || entry.type === "question") && entry.requestId === event.id);
      if (item && (item.type === "permission" || item.type === "question") && !item.resolved) {
        item.resolved = REQUEST_OUTCOME_LABELS[event.outcome];
      }
    } else if (event.type === "status") {
      this.setStatus(event.status);
    } else if (event.type === "result") {
      if (this.session) this.session.costUsd = event.costUsd;
    } else if (event.type === "error") {
      this.feed.push({ id, type: "error", message: event.message });
    }
  }
}

export function getChatStore(sessionId: string): ChatConnection {
  let store = stores.get(sessionId);
  if (!store) {
    store = new ChatConnection(sessionId);
    stores.set(sessionId, store);
  }
  return store;
}

export function disposeChatStore(sessionId: string): void {
  stores.get(sessionId)?.dispose();
}

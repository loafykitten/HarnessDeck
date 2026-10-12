/* The chat protocol, spoken by both the server (server/chat/) and the web UI.
   The web bundle imports this module's runtime values too, so it must stay
   pure: no node:/bun imports, nothing environment-specific. */

export type ChatHarness = "claude" | "codex";
export type ChatStatus = "working" | "waiting" | "idle";
export type RequestOutcome = "answered" | "allowed" | "always-allowed" | "denied" | "dismissed";

export const CHAT_MODELS = {
  claude: ["default", "fable", "opus", "sonnet", "haiku"],
  codex: ["default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
} as const satisfies Record<ChatHarness, readonly string[]>;

export const CHAT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
} as const satisfies Record<ChatHarness, readonly string[]>;

export const CHAT_PERMISSION_MODES = ["default", "plan", "acceptEdits", "bypassPermissions"] as const;

export type ClaudeChatModel = (typeof CHAT_MODELS.claude)[number];
export type CodexChatModel = (typeof CHAT_MODELS.codex)[number];
export type ChatModel = ClaudeChatModel | CodexChatModel;
export type ClaudeChatEffort = (typeof CHAT_EFFORTS.claude)[number];
export type CodexChatEffort = (typeof CHAT_EFFORTS.codex)[number];
export type ChatEffort = ClaudeChatEffort | CodexChatEffort;
export type ChatPermissionMode = (typeof CHAT_PERMISSION_MODES)[number];

/** The effort a new chat runs at when none is picked. */
export const defaultChatEffort = (harness: ChatHarness): ChatEffort =>
  harness === "codex" ? "medium" : "high";

export interface ChatOptions {
  model: ChatModel;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
}

export interface ChatQuestion {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

/** Context-window occupancy as of the latest turn. */
export interface ChatContext {
  used: number;
  window: number | null;
}

/** What a harness driver emits for one session. */
export type DriverEvent =
  | { type: "delta"; kind: "text" | "thinking"; text: string; parentToolUseId?: string }
  | { type: "block"; role: "user" | "assistant"; content: string; images?: string[]; parentToolUseId?: string }
  | { type: "tool"; phase: "start" | "end"; id: string; name: string; input?: unknown; result?: unknown; isError?: boolean; parentToolUseId?: string }
  | { type: "permission_request"; id: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }
  | { type: "question_request"; id: string; questions: ChatQuestion[] }
  | { type: "request_resolved"; id: string; outcome: RequestOutcome }
  | { type: "status"; status: ChatStatus }
  | { type: "context"; context: ChatContext }
  | { type: "result"; costUsd: number; usage: unknown; durationMs: number; context?: ChatContext }
  | { type: "error"; message: string };

/** What a chat socket carries after init: driver events plus the registry's
    echo of the effective options after a set_options (so a client that
    applied a change optimistically snaps back when the harness rejected it),
    each numbered by the session's seq. */
export type ChatEvent = (DriverEvent | ({ type: "options" } & ChatOptions)) & { seq: number };

export interface ChatSession extends ChatOptions {
  id: string;
  project: string;
  name: string;
  harness: ChatHarness;
  canBypassPermissions: boolean;
  /** Project-relative worktree path (".worktrees/worktree-…") when the chat
      is isolated; null runs in the project root. */
  worktree: string | null;
  sdkSessionId: string | null;
  status: ChatStatus;
  costUsd: number;
  totalTokens: number;
  /** Context occupancy of the latest turn. */
  contextUsed?: number;
  /** Context window size reported by the harness; null when unknown. */
  contextWindow?: number | null;
  created: number;
  lastActivity: number;
}

/** First message on a chat socket: a snapshot plus the buffered backlog. */
export interface ChatInit {
  type: "init";
  seq: number;
  /** Server boot id; changes on restart, when seqs restart with the rebuilt backlog. */
  epoch: string;
  session: ChatSession;
  backlog: ChatEvent[];
}

export type ChatClientMessage =
  | { type: "user_message"; text: string; imagePaths?: string[] }
  | { type: "permission_response"; id: string; behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; always?: boolean; message?: string }
  | { type: "question_response"; id: string; answers: Record<string, string[]> }
  | ({ type: "set_options" } & Partial<ChatOptions>)
  | { type: "interrupt" }
  | { type: "ping" };

/** A Claude turn's total tokens: input, output and both cache kinds, with
    anything missing or malformed counting as zero. */
export function usageTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const values = usage as Record<string, unknown>;
  return ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .reduce((total, key) => total + (typeof values[key] === "number" && Number.isFinite(values[key])
      ? Math.max(0, values[key])
      : 0), 0);
}

/** Chat titles are free text; branch and directory names are not. Length is
    capped so ref lock filenames stay well under filesystem limits, and the
    trim/.lock passes iterate until stable so no order of operations can
    re-expose an invalid suffix. The UI previews the result before creating. */
export function worktreeSlug(name: string): string {
  let slug = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/-{2,}/g, "-")
    .slice(0, 48);
  for (let prev = ""; prev !== slug; ) {
    prev = slug;
    slug = slug.replace(/^[-.]+|[-.]+$/g, "").replace(/\.lock$/, "");
  }
  return slug || "chat";
}

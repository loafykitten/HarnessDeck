export type ChatHarness = "claude" | "codex";
export type ClaudeChatModel = "default" | "fable" | "opus" | "sonnet" | "haiku";
export type CodexChatModel = "default" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
export type ChatModel = ClaudeChatModel | CodexChatModel;
export type ClaudeChatEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CodexChatEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatEffort = ClaudeChatEffort | CodexChatEffort;
export type ChatPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type ChatStatus = "working" | "waiting" | "idle";
export type RequestOutcome = "answered" | "allowed" | "always-allowed" | "denied" | "dismissed";

export const CHAT_MODELS = {
  claude: ["default", "fable", "opus", "sonnet", "haiku"],
  codex: ["default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
} as const satisfies Record<ChatHarness, readonly ChatModel[]>;

export const CHAT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
} as const satisfies Record<ChatHarness, readonly ChatEffort[]>;

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

export interface ChatQuestion {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

type Sequenced = { seq: number };
export type ChatEvent = Sequenced & (
  | { type: "delta"; kind: "text" | "thinking"; text: string; parentToolUseId?: string }
  | { type: "block"; role: "user" | "assistant"; content: string; parentToolUseId?: string }
  | { type: "tool"; phase: "start" | "end"; id: string; name: string; input?: unknown; result?: unknown; isError?: boolean; parentToolUseId?: string }
  | { type: "permission_request"; id: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }
  | { type: "question_request"; id: string; questions: ChatQuestion[] }
  | { type: "request_resolved"; id: string; outcome: RequestOutcome }
  | { type: "status"; status: ChatStatus }
  | { type: "result"; costUsd: number; usage: unknown; durationMs: number }
  | { type: "error"; message: string }
);

export interface ChatInit {
  type: "init";
  seq: number;
  session: ChatSession;
  backlog: ChatEvent[];
}

export type ChatClientMessage =
  | { type: "user_message"; text: string }
  | { type: "permission_response"; id: string; behavior: "allow" | "deny"; updatedInput?: Record<string, unknown>; always?: boolean; message?: string }
  | { type: "question_response"; id: string; answers: Record<string, string[]> }
  | { type: "set_options"; model?: ChatModel; effort?: ChatEffort; permissionMode?: ChatPermissionMode }
  | { type: "interrupt" }
  | { type: "ping" };

export type ChatFeedItem =
  | { id: string; type: "message"; role: "user" | "assistant"; text: string; streaming?: boolean; parentToolUseId?: string }
  | { id: string; type: "thinking"; text: string; streaming?: boolean; parentToolUseId?: string }
  | { id: string; type: "tool"; toolId: string; name: string; input?: unknown; result?: unknown; isError?: boolean; running: boolean; parentToolUseId?: string }
  | { id: string; type: "permission"; requestId: string; toolName: string; input: Record<string, unknown>; resolved?: string }
  | { id: string; type: "question"; requestId: string; questions: ChatQuestion[]; resolved?: string }
  | { id: string; type: "error"; message: string };

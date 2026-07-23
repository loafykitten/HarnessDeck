export type ChatStatus = "working" | "waiting" | "idle";
export type ChatHarness = "claude" | "codex";
export type ClaudeChatModel = "default" | "fable" | "opus" | "sonnet" | "haiku";
export type CodexChatModel = "default" | "gpt-5.6-sol" | "gpt-5.6-terra" | "gpt-5.6-luna";
export type ChatModel = ClaudeChatModel | CodexChatModel;
export type ClaudeChatEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type CodexChatEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
export type ChatEffort = ClaudeChatEffort | CodexChatEffort;
export type ChatPermissionMode = "default" | "plan" | "acceptEdits" | "bypassPermissions";
export type RequestOutcome = "answered" | "allowed" | "always-allowed" | "denied" | "dismissed";

export interface ChatOptions {
  model: ChatModel;
  effort: ChatEffort;
  permissionMode: ChatPermissionMode;
}

export interface ChatStartOptions extends ChatOptions {
  cwd: string;
  canBypassPermissions?: boolean;
  continuationId?: string;
  onContinuationId?: (id: string) => void;
}

export interface PermissionResponse {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  always?: boolean;
  message?: string;
}

export interface QuestionResponse {
  answers: Record<string, string[]>;
}

export interface ChatQuestion {
  question: string;
  header: string;
  options: { label: string; description: string; preview?: string }[];
  multiSelect: boolean;
}

export type DriverEvent =
  | { type: "delta"; kind: "text" | "thinking"; text: string; parentToolUseId?: string }
  | { type: "block"; role: "user" | "assistant"; content: string; parentToolUseId?: string }
  | { type: "tool"; phase: "start" | "end"; id: string; name: string; input?: unknown; result?: unknown; isError?: boolean; parentToolUseId?: string }
  | { type: "permission_request"; id: string; toolName: string; input: Record<string, unknown>; suggestions?: unknown[] }
  | { type: "question_request"; id: string; questions: ChatQuestion[] }
  | { type: "request_resolved"; id: string; outcome: RequestOutcome }
  | { type: "status"; status: ChatStatus }
  | { type: "result"; costUsd: number; usage: unknown; durationMs: number }
  | { type: "error"; message: string };

export interface ChatHandle {
  /** Set once the underlying agent process is gone for good; the registry starts a fresh handle. */
  readonly dead?: boolean;
  send(text: string): void;
  respondPermission(id: string, response: PermissionResponse): void;
  respondQuestion(id: string, response: QuestionResponse): void;
  setOptions(options: Partial<ChatOptions>): Promise<void>;
  interrupt(): Promise<void>;
  stop(): Promise<void>;
  onEvent(callback: (event: DriverEvent) => void): () => void;
}

export interface ChatDriver {
  start(options: ChatStartOptions): ChatHandle;
}

import type { ChatOptions, DriverEvent } from "../../shared/chat";

/* The protocol types live in shared/ (the web UI speaks them too); they are
   re-exported here so drivers keep a single import site. */
export type {
  ChatContext,
  ChatEffort,
  ChatHarness,
  ChatModel,
  ChatOptions,
  ChatPermissionMode,
  ChatQuestion,
  ChatStatus,
  ClaudeChatEffort,
  ClaudeChatModel,
  CodexChatEffort,
  CodexChatModel,
  DriverEvent,
  RequestOutcome,
} from "../../shared/chat";

export interface ChatStartOptions extends ChatOptions {
  cwd: string;
  /** Extra sandbox-writable paths beyond cwd — a linked worktree needs parts
      of the shared repository writable or every git command fails. */
  extraWritableRoots?: string[];
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

export interface ChatHandle {
  /** Set once the underlying agent process is gone for good; the registry starts a fresh handle. */
  readonly dead?: boolean;
  send(text: string, imagePaths?: string[]): Promise<void>;
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

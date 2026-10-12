/* The chat protocol lives in shared/chat.ts, where the server reads it too;
   this module re-exports it for the UI alongside the web-only shapes. */
import type { ChatPermissionMode, ChatQuestion } from "../../../shared/chat";

export * from "../../../shared/chat";

export const PERMISSION_MODE_LABELS: Record<ChatPermissionMode, string> = {
  default: "default",
  plan: "plan",
  acceptEdits: "accept edits",
  bypassPermissions: "skip approvals",
};

export type ChatFeedItem =
  | { id: string; type: "message"; role: "user" | "assistant"; text: string; images?: string[]; streaming?: boolean; parentToolUseId?: string }
  | { id: string; type: "thinking"; text: string; streaming?: boolean; parentToolUseId?: string }
  | { id: string; type: "tool"; toolId: string; name: string; input?: unknown; result?: unknown; isError?: boolean; running: boolean; parentToolUseId?: string }
  // sending: answered locally but not yet confirmed by request_resolved.
  | { id: string; type: "permission"; requestId: string; toolName: string; input: Record<string, unknown>; resolved?: string; sending?: boolean }
  | { id: string; type: "question"; requestId: string; questions: ChatQuestion[]; resolved?: string; sending?: boolean }
  | { id: string; type: "error"; message: string };

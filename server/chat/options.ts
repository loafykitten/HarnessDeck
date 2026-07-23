import type { ChatEffort, ChatHarness, ChatModel, ChatPermissionMode } from "./driver";

export const CHAT_MODELS = {
  claude: ["default", "fable", "opus", "sonnet", "haiku"],
  codex: ["default", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"],
} as const satisfies Record<ChatHarness, readonly ChatModel[]>;

export const CHAT_EFFORTS = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["low", "medium", "high", "xhigh", "max", "ultra"],
} as const satisfies Record<ChatHarness, readonly ChatEffort[]>;

export const CHAT_PERMISSION_MODES = [
  "default",
  "plan",
  "acceptEdits",
  "bypassPermissions",
] as const satisfies readonly ChatPermissionMode[];

export const isChatHarness = (value: unknown): value is ChatHarness =>
  value === "claude" || value === "codex";

export const isChatModel = (harness: ChatHarness, value: unknown): value is ChatModel =>
  typeof value === "string" && (CHAT_MODELS[harness] as readonly string[]).includes(value);

export const isChatEffort = (harness: ChatHarness, value: unknown): value is ChatEffort =>
  typeof value === "string" && (CHAT_EFFORTS[harness] as readonly string[]).includes(value);

export const isChatPermissionMode = (value: unknown): value is ChatPermissionMode =>
  typeof value === "string" && (CHAT_PERMISSION_MODES as readonly string[]).includes(value);

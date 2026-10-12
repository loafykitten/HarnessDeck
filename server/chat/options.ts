import {
  CHAT_EFFORTS,
  CHAT_MODELS,
  CHAT_PERMISSION_MODES,
  type ChatEffort,
  type ChatHarness,
  type ChatModel,
  type ChatPermissionMode,
} from "../../shared/chat";

/* Request validation for chat options: the option lists themselves live in
   shared/chat.ts, where the UI's pickers read them too. */

export const isChatHarness = (value: unknown): value is ChatHarness =>
  value === "claude" || value === "codex";

export const isChatModel = (harness: ChatHarness, value: unknown): value is ChatModel =>
  typeof value === "string" && (CHAT_MODELS[harness] as readonly string[]).includes(value);

export const isChatEffort = (harness: ChatHarness, value: unknown): value is ChatEffort =>
  typeof value === "string" && (CHAT_EFFORTS[harness] as readonly string[]).includes(value);

export const isChatPermissionMode = (value: unknown): value is ChatPermissionMode =>
  typeof value === "string" && (CHAT_PERMISSION_MODES as readonly string[]).includes(value);

import type { WebSocketHandler } from "bun";
import type { ChatEffort, ChatModel, ChatPermissionMode } from "./driver";
import {
  chatInit,
  interruptChat,
  respondChatPermission,
  respondChatQuestion,
  sendChatMessage,
  setChatOptions,
  subscribeChat,
} from "./sessions";

export type ChatWsData = { chatId: string; unsubscribe?: () => void };

const MODELS = new Set<ChatModel>(["default", "fable", "opus", "sonnet", "haiku"]);
const EFFORTS = new Set<ChatEffort>(["low", "medium", "high", "xhigh", "max"]);
const MODES = new Set<ChatPermissionMode>(["default", "plan", "acceptEdits", "bypassPermissions"]);

export const chatWebsocket: WebSocketHandler<ChatWsData> = {
  idleTimeout: 960,
  open(ws) {
    const init = chatInit(ws.data.chatId);
    if (!init) return ws.close(1008, "no such chat session");
    ws.send(JSON.stringify({ type: "init", ...init }));
    ws.data.unsubscribe = subscribeChat(ws.data.chatId, event => {
      try { ws.send(JSON.stringify(event)); } catch { /* socket gone */ }
    }) ?? undefined;
  },
  async message(ws, raw) {
    if (typeof raw !== "string") return;
    let message: Record<string, unknown>;
    try { message = JSON.parse(raw); } catch { return; }
    const id = ws.data.chatId;
    if (message.type === "user_message" && typeof message.text === "string") {
      sendChatMessage(id, message.text);
    } else if (message.type === "permission_response" && typeof message.id === "string") {
      respondChatPermission(id, message.id, {
        behavior: message.behavior === "allow" ? "allow" : "deny",
        updatedInput: message.updatedInput as Record<string, unknown> | undefined,
        always: message.always === true,
        message: typeof message.message === "string" ? message.message : undefined,
      });
    } else if (message.type === "question_response" && typeof message.id === "string") {
      const answers = message.answers && typeof message.answers === "object"
        ? Object.fromEntries(Object.entries(message.answers).map(([question, answer]) => [
          question,
          Array.isArray(answer) ? answer.filter((item): item is string => typeof item === "string") : [],
        ]))
        : {};
      respondChatQuestion(id, message.id, { answers });
    } else if (message.type === "set_options") {
      const { model, effort, permissionMode } = message;
      await setChatOptions(id, {
        model: MODELS.has(model as ChatModel) ? model as ChatModel : undefined,
        effort: EFFORTS.has(effort as ChatEffort) ? effort as ChatEffort : undefined,
        permissionMode: MODES.has(permissionMode as ChatPermissionMode) ? permissionMode as ChatPermissionMode : undefined,
      });
    } else if (message.type === "interrupt") {
      await interruptChat(id);
    }
  },
  close(ws) {
    ws.data.unsubscribe?.();
    ws.data.unsubscribe = undefined;
  },
};

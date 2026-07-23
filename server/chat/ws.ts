import type { WebSocketHandler } from "bun";
import {
  chatInit,
  chatSessionHarness,
  interruptChat,
  reportChatError,
  respondChatPermission,
  respondChatQuestion,
  sendChatMessage,
  setChatOptions,
  subscribeChat,
} from "./sessions";
import { isChatEffort, isChatModel, isChatPermissionMode } from "./options";

export type ChatWsData = { chatId: string; unsubscribe?: () => void };

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
      const harness = chatSessionHarness(id);
      if (!harness) return;
      const options: Parameters<typeof setChatOptions>[1] = {};
      if (model !== undefined) {
        if (isChatModel(harness, model)) options.model = model;
        else reportChatError(id, `unknown ${harness} model: ${model}`);
      }
      if (effort !== undefined) {
        if (isChatEffort(harness, effort)) options.effort = effort;
        else reportChatError(id, `unknown ${harness} effort: ${effort}`);
      }
      if (permissionMode !== undefined) {
        if (isChatPermissionMode(permissionMode)) options.permissionMode = permissionMode;
        else reportChatError(id, `unknown permission mode: ${permissionMode}`);
      }
      if (Object.keys(options).length) await setChatOptions(id, options);
    } else if (message.type === "interrupt") {
      await interruptChat(id);
    }
  },
  close(ws) {
    ws.data.unsubscribe?.();
    ws.data.unsubscribe = undefined;
  },
};

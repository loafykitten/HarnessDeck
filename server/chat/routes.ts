import { err, json, type RouteHandler } from "../http";
import {
  createChatSession,
  deleteChatSession,
  listChatSessions,
} from "./sessions";
import type { ChatEffort, ChatModel, ChatPermissionMode } from "./driver";

const MODELS = new Set<ChatModel>(["default", "fable", "opus", "sonnet", "haiku"]);
const EFFORTS = new Set<ChatEffort>(["low", "medium", "high", "xhigh", "max"]);
const MODES = new Set<ChatPermissionMode>(["default", "plan", "acceptEdits", "bypassPermissions"]);

export const chatRoutes: RouteHandler = async (req, url) => {
  if (url.pathname === "/api/chat/sessions" && req.method === "GET") {
    return json(await listChatSessions(url.searchParams.get("project") ?? undefined));
  }
  if (url.pathname === "/api/chat/sessions" && req.method === "POST") {
    const body = await req.json() as Record<string, unknown>;
    if (typeof body.project !== "string" || typeof body.name !== "string") {
      return err("project and name required");
    }
    const harness = body.harness ?? "claude";
    const model = body.model ?? "default";
    const effort = body.effort ?? "high";
    const permissionMode = body.permissionMode ?? "default";
    if (harness !== "claude") return err(`unsupported chat harness: ${harness}`);
    if (!MODELS.has(model as ChatModel)) return err(`unknown model: ${model}`);
    if (!EFFORTS.has(effort as ChatEffort)) return err(`unknown effort: ${effort}`);
    if (!MODES.has(permissionMode as ChatPermissionMode)) return err(`unknown permission mode: ${permissionMode}`);
    try {
      const session = await createChatSession({
        project: body.project,
        name: body.name.trim() || "chat",
        harness,
        model: model as ChatModel,
        effort: effort as ChatEffort,
        permissionMode: permissionMode as ChatPermissionMode,
      });
      return json(session, 201);
    } catch (error) {
      return err(error instanceof Error ? error.message : "create failed", 404);
    }
  }
  const match = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (match && req.method === "DELETE") {
    const ok = await deleteChatSession(decodeURIComponent(match[1]));
    return ok ? json({ ok: true }) : err("no such chat session", 404);
  }
  return null;
};

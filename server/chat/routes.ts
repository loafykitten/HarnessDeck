import { err, json, type RouteHandler } from "../http";
import {
  createChatSession,
  deleteChatSession,
  listChatSessions,
} from "./sessions";
import {
  isChatEffort,
  isChatHarness,
  isChatModel,
  isChatPermissionMode,
} from "./options";

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
    const effort = body.effort ?? (harness === "codex" ? "medium" : "high");
    const permissionMode = body.permissionMode ?? "default";
    if (!isChatHarness(harness)) return err(`unsupported chat harness: ${harness}`);
    if (!isChatModel(harness, model)) return err(`unknown ${harness} model: ${model}`);
    if (!isChatEffort(harness, effort)) return err(`unknown ${harness} effort: ${effort}`);
    if (!isChatPermissionMode(permissionMode)) return err(`unknown permission mode: ${permissionMode}`);
    try {
      const session = await createChatSession({
        project: body.project,
        name: body.name.trim() || "chat",
        harness,
        model,
        effort,
        permissionMode,
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

import { err, json, type RouteHandler } from "../http";
import {
  createChatSession,
  deleteChatSession,
  hasChatSession,
  listChatSessions,
} from "./sessions";
import { imageExtension, readImageUpload } from "../pastes";
import {
  MAX_CHAT_IMAGE_BYTES,
  resolveChatImage,
  saveChatImage,
} from "./images";
import {
  isChatEffort,
  isChatHarness,
  isChatModel,
  isChatPermissionMode,
} from "./options";
import { defaultChatEffort } from "../../shared/chat";

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
    if (!isChatHarness(harness)) return err(`unsupported chat harness: ${harness}`);
    const model = body.model ?? "default";
    const effort = body.effort ?? defaultChatEffort(harness);
    const permissionMode = body.permissionMode ?? "default";
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
        worktree: body.worktree === true,
      });
      return json(session, 201);
    } catch (error) {
      return err(error instanceof Error ? error.message : "create failed", 404);
    }
  }
  const imageMatch = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)\/image$/);
  if (imageMatch && req.method === "POST") {
    const id = decodeURIComponent(imageMatch[1]);
    if (!(await hasChatSession(id))) return err("no such chat session", 404);
    // Chat images are inlined into the request, so the harness must accept the type.
    const extension = imageExtension(req.headers.get("content-type") ?? "");
    if (!extension) return err("unsupported image type", 415);
    const blob = await readImageUpload(req, MAX_CHAT_IMAGE_BYTES, "image too large (max 5 MB)");
    if (blob instanceof Response) return blob;
    const path = await saveChatImage(blob, extension);
    return json({ ok: true, path });
  }
  // Serves a pasted image back to the feed. The basename is an unguessable
  // uuid and the bytes never change, so it caches immutably.
  const pasteMatch = url.pathname.match(/^\/api\/chat\/pastes\/([^/]+)$/);
  if (pasteMatch && req.method === "GET") {
    const path = await resolveChatImage(decodeURIComponent(pasteMatch[1]));
    if (!path) return err("no such image", 404);
    return new Response(Bun.file(path), {
      headers: { "cache-control": "private, max-age=31536000, immutable" },
    });
  }
  const match = url.pathname.match(/^\/api\/chat\/sessions\/([^/]+)$/);
  if (match && req.method === "DELETE") {
    const ok = await deleteChatSession(decodeURIComponent(match[1]));
    return ok ? json({ ok: true }) : err("no such chat session", 404);
  }
  return null;
};

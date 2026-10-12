import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { err, json, type RouteHandler } from "../http";
import { DEFAULT_HARNESS, isHarnessId } from "../harness/registry";
import { PASTE_DIR } from "../paths";
import { imageExtension, pruneOldPastes, readImageUpload } from "../pastes";
import { createSession, hasSession, killSession, listSessions, typeIntoSession } from "./sessions";

// Terminal pastes are only handed to the agent as a path, so nothing inlines
// them into an API request — the cap just bounds disk use.
const MAX_PASTE_BYTES = 32 * 1024 * 1024;
// A paste is consumed when the prompt it was typed into is sent.
const PASTE_RETENTION_MS = 24 * 60 * 60_000;

export const terminalRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

  if (pathname === "/api/sessions" && req.method === "GET") {
    return json(await listSessions());
  }
  if (pathname === "/api/sessions" && req.method === "POST") {
    const body = await req.json();
    if (typeof body.project !== "string" || typeof body.name !== "string" || !body.project || !body.name) {
      return err("project and name required");
    }
    const harness = body.harness ?? DEFAULT_HARNESS;
    if (!isHarnessId(harness)) return err(`unknown harness: ${harness}`);
    const res = await createSession(body.project, body.name, harness);
    return "error" in res ? err(res.error, 409) : json(res, 201);
  }
  const sessMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (sessMatch && req.method === "DELETE") {
    const ok = await killSession(decodeURIComponent(sessMatch[1]));
    return ok ? json({ ok: true }) : err("kill failed", 404);
  }
  const aliveMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/alive$/);
  if (aliveMatch && req.method === "GET") {
    return json({ alive: await hasSession(decodeURIComponent(aliveMatch[1])) });
  }
  const imgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/image$/);
  if (imgMatch && req.method === "POST") {
    const id = decodeURIComponent(imgMatch[1]);
    if (!(await hasSession(id))) return err("no such session", 404);
    const blob = await readImageUpload(req, MAX_PASTE_BYTES, "image too large");
    if (blob instanceof Response) return blob;
    const ext = imageExtension(blob.type) ?? ".png";
    await mkdir(PASTE_DIR, { recursive: true });
    const path = join(PASTE_DIR, `paste-${Date.now()}${ext}`);
    await Bun.write(path, blob);
    // Type the path into claude's input (quoted, no Enter — user submits)
    await typeIntoSession(id, `'${path}' `);
    void pruneOldPastes(PASTE_DIR, PASTE_RETENTION_MS).catch(() => {});
    return json({ ok: true, path });
  }

  return null;
};

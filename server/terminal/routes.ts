import { homedir } from "node:os";
import { join } from "node:path";
import { mkdir, readdir, stat, unlink } from "node:fs/promises";
import { err, json, type RouteHandler } from "../http";
import { DEFAULT_HARNESS, isHarnessId } from "../harness/registry";
import { createSession, hasSession, killSession, listSessions, typeIntoSession } from "./sessions";

const PASTE_DIR = join(homedir(), "Library", "Caches", "HarnessDeck", "pastes");
const MAX_PASTE_BYTES = 32 * 1024 * 1024;

async function pruneOldPastes(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const entries = await readdir(PASTE_DIR, { withFileTypes: true });
  await Promise.all(entries.flatMap(entry => {
    if (!entry.isFile() || !entry.name.startsWith("paste-")) return [];
    const path = join(PASTE_DIR, entry.name);
    return [stat(path).then(s => s.mtimeMs < cutoff ? unlink(path) : undefined)];
  }));
}

export const terminalRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

  if (pathname === "/api/sessions" && req.method === "GET") {
    return json(await listSessions());
  }
  if (pathname === "/api/sessions" && req.method === "POST") {
    const body = await req.json();
    if (!body.project || !body.name) return err("project and name required");
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
    const contentLength = Number(req.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > MAX_PASTE_BYTES) {
      return err("image too large", 413);
    }
    const blob = await req.blob();
    if (blob.size === 0) return err("empty body");
    if (blob.size > MAX_PASTE_BYTES) return err("image too large", 413);
    const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[blob.type] ?? ".png";
    await mkdir(PASTE_DIR, { recursive: true });
    const path = join(PASTE_DIR, `paste-${Date.now()}${ext}`);
    await Bun.write(path, blob);
    // Type the path into claude's input (quoted, no Enter — user submits)
    await typeIntoSession(id, `'${path}' `);
    void pruneOldPastes().catch(() => {});
    return json({ ok: true, path });
  }

  return null;
};

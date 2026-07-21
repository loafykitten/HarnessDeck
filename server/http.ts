import { join } from "node:path";
import { DEFAULT_HARNESS, isHarnessId, type HarnessId } from "./harness/registry";

const DIST = join(import.meta.dir, "..", "web", "dist");

export const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
export const err = (message: string, status = 400) => json({ error: message }, status);

export const text = (body: string, contentType = "text/plain; charset=utf-8") =>
  new Response(body, { headers: { "content-type": contentType } });

/** ?harness= param with claude as the default, or null when unknown. */
export function harnessParam(url: URL): HarnessId | null {
  const h = url.searchParams.get("harness") ?? DEFAULT_HARNESS;
  return isHarnessId(h) ? h : null;
}

export async function serveStatic(pathname: string): Promise<Response> {
  const path = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(DIST, path));
  if (await file.exists()) return new Response(file);
  // SPA fallback
  const index = Bun.file(join(DIST, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("web/dist not built — run: bun run build", { status: 503 });
}

/** A feature's route handler: respond, or return null to pass. */
export type RouteHandler = (req: Request, url: URL) => Promise<Response | null> | Response | null;

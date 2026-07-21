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

function acceptsGzip(req: Request): boolean {
  return (req.headers.get("accept-encoding") ?? "").split(",").some(part => {
    const [encoding, ...params] = part.split(";");
    return encoding.trim().toLowerCase() === "gzip"
      && !params.some(p => /^\s*q=0(?:\.0*)?\s*$/i.test(p));
  });
}

async function staticResponse(req: Request, path: string, cacheControl: string): Promise<Response | null> {
  const file = Bun.file(join(DIST, path));
  if (!(await file.exists())) return null;
  if (acceptsGzip(req)) {
    const gzip = Bun.file(join(DIST, path + ".gz"));
    if (await gzip.exists()) {
      return new Response(gzip, { headers: {
        "cache-control": cacheControl,
        "content-encoding": "gzip",
        "content-type": file.type,
        "vary": "Accept-Encoding",
      } });
    }
  }
  return new Response(file, { headers: { "cache-control": cacheControl } });
}

export async function serveStatic(req: Request, pathname: string): Promise<Response> {
  const path = pathname === "/" ? "/index.html" : pathname;
  // Safari heuristic-caches responses without Cache-Control; hashed assets are immutable, everything else revalidates.
  const cacheControl = path.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache";
  const response = await staticResponse(req, path, cacheControl);
  if (response) return response;
  // SPA fallback
  const index = await staticResponse(req, "index.html", "no-cache");
  if (index) return index;
  return new Response("web/dist not built — run: bun run build", { status: 503 });
}

/** A feature's route handler: respond, or return null to pass. */
export type RouteHandler = (req: Request, url: URL) => Promise<Response | null> | Response | null;

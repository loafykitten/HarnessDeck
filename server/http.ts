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

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "[::1]"];

function hostnameOf(host: string): string | null {
  try {
    return new URL(`http://${host}`).hostname.replace(/\.$/, "");
  } catch {
    return null;
  }
}

/** There's no login, so this is what stops other sites from driving the
    terminals. Host must be one we serve under (defeats DNS rebinding: a
    rebound evil.example still sends its own Host). Origin, which browsers
    send on CORS fetches, every non-GET, and every WebSocket handshake, must
    name that same host — a page elsewhere can't POST here or open a socket.
    Requests without Origin are navigations, plain subresource GETs, or not
    from a browser at all (curl, hooks), and are allowed. `extraHosts` are tailnet names/IPs and the
    HARNESSDECK_ALLOWED_HOSTS override. Returns a rejection reason or null. */
export function rejectUntrustedRequest(headers: Headers, extraHosts: ReadonlySet<string>): string | null {
  const host = headers.get("host")?.toLowerCase();
  const hostname = host ? hostnameOf(host) : null;
  if (!host || !hostname) return "missing host";
  const allowed = LOOPBACK_HOSTS.includes(hostname) || hostname.endsWith(".ts.net") || extraHosts.has(hostname);
  if (!allowed) return `host not allowed: ${hostname}`;

  const origin = headers.get("origin");
  if (origin === null) return null;
  try {
    const o = new URL(origin);
    // re-parse Host under Origin's scheme so a default port compares equal
    if (new URL(`${o.protocol}//${host}`).host === o.host) return null;
  } catch { /* "null" or garbage */ }
  return "cross-origin request";
}

/** A feature's route handler: respond, or return null to pass. */
export type RouteHandler = (req: Request, url: URL) => Promise<Response | null> | Response | null;

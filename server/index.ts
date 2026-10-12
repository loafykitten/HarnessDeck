import type { ServerWebSocket, WebSocketHandler } from "bun";
import { err, json, rejectUntrustedRequest, serveStatic, type RouteHandler } from "./http";
import { hasSession, reconcilePersistedSessions } from "./terminal/sessions";
import { terminalRoutes } from "./terminal/routes";
import { terminalWebsocket, type WsData as TerminalWsData } from "./terminal/ws";
import { chatRoutes } from "./chat/routes";
import { hasChatSession } from "./chat/sessions";
import { chatWebsocket, type ChatWsData } from "./chat/ws";
import { projectRoutes } from "./projects/routes";
import { restartRoutes } from "./restart";
import { usageRoutes } from "./usage/routes";
import { skillRoutes } from "./skills/routes";
import { configRoutes } from "./config/routes";
import { harnessRoutes } from "./harness/routes";
import { getGreeting } from "./greeting";
import { getNews } from "./news/news";
import { ensureTailscaleServe, tailnetHosts } from "./tailscale";

const PORT = Number(process.env.PORT) || 4553;

/** Hostnames served beyond loopback and *.ts.net (comma-separated, e.g. for
    a reverse proxy of your own); the tailnet's names/IPs join at startup. */
const allowedHosts = new Set(
  (process.env.HARNESSDECK_ALLOWED_HOSTS ?? "").split(",")
    .map(h => h.trim().toLowerCase().replace(/\.$/, ""))
    .filter(Boolean),
);

await reconcilePersistedSessions();

type WsData = TerminalWsData | ChatWsData;

/** The upgrade stamped ws.data with exactly one of the two shapes, so the
    handler picked by that shape always gets the data it was written for. */
const handlerFor = (ws: ServerWebSocket<WsData>) =>
  ("chatId" in ws.data ? chatWebsocket : terminalWebsocket) as WebSocketHandler<WsData>;

const websocket: WebSocketHandler<WsData> = {
  // Only this combined handler's options reach Bun. The default is 120s, and
  // background tabs go quiet longer than that; clients also ping every 30s.
  idleTimeout: 960,
  open(ws) {
    handlerFor(ws).open?.(ws);
  },
  async message(ws, message) {
    await handlerFor(ws).message?.(ws, message);
  },
  close(ws, code, reason) {
    handlerFor(ws).close?.(ws, code, reason);
  },
};

const routes: RouteHandler[] = [
  projectRoutes,
  terminalRoutes,
  chatRoutes,
  harnessRoutes,
  restartRoutes,
  usageRoutes,
  skillRoutes,
  configRoutes,
  async (req, url) => {
    if (url.pathname === "/api/greeting" && req.method === "GET") return json(await getGreeting());
    if (url.pathname === "/api/news" && req.method === "GET") return json(await getNews());
    return null;
  },
];

const server = Bun.serve<WsData>({
  port: PORT,
  hostname: "127.0.0.1",
  idleTimeout: 60,

  async fetch(req, server) {
    const rejected = rejectUntrustedRequest(req.headers, allowedHosts);
    if (rejected) {
      console.warn(`[403 ${req.method}] ${rejected}`);
      return err(rejected, 403);
    }

    const url = new URL(req.url);
    const { pathname } = url;

    // ---- WebSocket: terminal attach ----
    const wsMatch = pathname.match(/^\/ws\/session\/([^/]+)$/);
    if (wsMatch) {
      const sessionId = decodeURIComponent(wsMatch[1]);
      if (!(await hasSession(sessionId))) return err("no such session", 404);
      if (server.upgrade(req, { data: { sessionId } })) return undefined as unknown as Response;
      return err("websocket upgrade failed", 400);
    }

    const chatMatch = pathname.match(/^\/ws\/chat\/([^/]+)$/);
    if (chatMatch) {
      const chatId = decodeURIComponent(chatMatch[1]);
      if (!(await hasChatSession(chatId))) return err("no such chat session", 404);
      if (server.upgrade(req, { data: { chatId } })) return undefined as unknown as Response;
      return err("websocket upgrade failed", 400);
    }

    try {
      for (const route of routes) {
        const res = await route(req, url);
        if (res) return res;
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) return err("not found", 404);
      return serveStatic(req, pathname);
    } catch (e) {
      console.error(`[${req.method} ${pathname}]`, e);
      return err(e instanceof Error ? e.message : "internal error", 500);
    }
  },

  websocket,
});

console.log(`HarnessDeck → http://localhost:${server.port} (loopback only)`);
if (PORT === 4553) {
  ensureTailscaleServe(PORT).then(url => {
    for (const host of tailnetHosts) allowedHosts.add(host);
    if (url) console.log(`              ⤷ tailnet ${url}`);
  });
}

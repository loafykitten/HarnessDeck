import { err, json, serveStatic, type RouteHandler } from "./http";
import { hasSession } from "./terminal/sessions";
import { terminalRoutes } from "./terminal/routes";
import { terminalWebsocket, type WsData } from "./terminal/ws";
import { projectRoutes } from "./projects/routes";
import { usageRoutes } from "./usage/routes";
import { skillRoutes } from "./skills/routes";
import { configRoutes } from "./config/routes";
import { harnessRoutes } from "./harness/routes";
import { getGreeting } from "./greeting";
import { getNews } from "./news/news";
import { ensureTailscaleServe } from "./tailscale";

const PORT = 4553;

const routes: RouteHandler[] = [
  projectRoutes,
  terminalRoutes,
  harnessRoutes,
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

    try {
      for (const route of routes) {
        const res = await route(req, url);
        if (res) return res;
      }
      if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) return err("not found", 404);
      return serveStatic(pathname);
    } catch (e) {
      console.error(`[${req.method} ${pathname}]`, e);
      return err(e instanceof Error ? e.message : "internal error", 500);
    }
  },

  websocket: terminalWebsocket,
});

console.log(`HarnessDeck → http://localhost:${server.port} (loopback only)`);
ensureTailscaleServe(PORT).then(url => {
  if (url) console.log(`              ⤷ tailnet ${url}`);
});

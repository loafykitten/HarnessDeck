import { spawn as ptySpawn, type IPty } from "bun-pty";
import { homedir } from "node:os";
import { join, extname } from "node:path";
import { mkdir } from "node:fs/promises";
import { listProjects } from "./projects";
import { createSession, hasSession, killSession, listSessions, newlineIntoSession, typeIntoSession } from "./sessions";
import { getLimits, getMonth, invalidateUsageCaches } from "./usage";
import { getGreeting } from "./greeting";
import {
  getAppConfig, setAppConfig,
  readSettings, writeSettings, readClaudeMd, writeClaudeMd,
} from "./config";
import {
  listSkills, getSkill, readSkillFile, writeSkillFile, deleteSkill,
  installFromUrl, generateSkill, getJob,
} from "./skills";

const PORT = 4553;
const DIST = join(import.meta.dir, "..", "web", "dist");
const PASTE_DIR = join(homedir(), "Library", "Caches", "ClaudeCommand", "pastes");

type WsData = { sessionId: string; pty?: IPty };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const err = (message: string, status = 400) => json({ error: message }, status);

async function serveStatic(pathname: string): Promise<Response> {
  const path = pathname === "/" ? "/index.html" : pathname;
  const file = Bun.file(join(DIST, path));
  if (await file.exists()) return new Response(file);
  // SPA fallback
  const index = Bun.file(join(DIST, "index.html"));
  if (await index.exists()) return new Response(index);
  return new Response("web/dist not built — run: bun run build", { status: 503 });
}

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
      // ---- REST ----
      if (pathname === "/api/projects" && req.method === "GET") {
        return json(await listProjects());
      }
      if (pathname === "/api/sessions" && req.method === "GET") {
        return json(await listSessions());
      }
      if (pathname === "/api/sessions" && req.method === "POST") {
        const body = await req.json();
        if (!body.project || !body.name) return err("project and name required");
        const res = await createSession(body.project, body.name);
        return "error" in res ? err(res.error, 409) : json(res, 201);
      }
      const sessMatch = pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (sessMatch && req.method === "DELETE") {
        const ok = await killSession(decodeURIComponent(sessMatch[1]));
        return ok ? json({ ok: true }) : err("kill failed", 404);
      }
      const imgMatch = pathname.match(/^\/api\/sessions\/([^/]+)\/image$/);
      if (imgMatch && req.method === "POST") {
        const id = decodeURIComponent(imgMatch[1]);
        if (!(await hasSession(id))) return err("no such session", 404);
        const blob = await req.blob();
        if (blob.size === 0) return err("empty body");
        if (blob.size > 32 * 1024 * 1024) return err("image too large", 413);
        const ext = { "image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp" }[blob.type] ?? ".png";
        await mkdir(PASTE_DIR, { recursive: true });
        const path = join(PASTE_DIR, `paste-${Date.now()}${ext}`);
        await Bun.write(path, blob);
        // Type the path into claude's input (quoted, no Enter — user submits)
        await typeIntoSession(id, `'${path}' `);
        return json({ ok: true, path });
      }

      if (pathname === "/api/usage" && req.method === "GET") {
        // Partial-failure tolerant: each half degrades independently
        const [limits, month] = await Promise.allSettled([getLimits(), getMonth()]);
        return json({
          limits: limits.status === "fulfilled" ? limits.value : null,
          month: month.status === "fulfilled" ? month.value : null,
          errors: [
            ...(limits.status === "rejected" ? [`limits: ${limits.reason}`] : []),
            ...(month.status === "rejected" ? [`month: ${month.reason}`] : []),
          ],
        });
      }

      if (pathname === "/api/greeting" && req.method === "GET") {
        return json(await getGreeting());
      }

      // ---- Skills ----
      if (pathname === "/api/skills" && req.method === "GET") {
        return json(await listSkills());
      }
      if (pathname === "/api/skills/install" && req.method === "POST") {
        const body = await req.json();
        const res = await installFromUrl(String(body.url ?? ""));
        return "error" in res ? err(res.error) : json(res);
      }
      if (pathname === "/api/skills/generate" && req.method === "POST") {
        const body = await req.json();
        const res = await generateSkill(String(body.name ?? ""), String(body.prompt ?? ""));
        return "error" in res ? err(res.error) : json(res, 202);
      }
      const jobMatch = pathname.match(/^\/api\/skills\/jobs\/([^/]+)$/);
      if (jobMatch && req.method === "GET") {
        const job = getJob(jobMatch[1]);
        return job ? json(job) : err("no such job", 404);
      }
      const skillFileMatch = pathname.match(/^\/api\/skills\/([^/]+)\/file$/);
      if (skillFileMatch) {
        const name = decodeURIComponent(skillFileMatch[1]);
        const rel = url.searchParams.get("path") ?? "";
        if (req.method === "GET") {
          const text = await readSkillFile(name, rel);
          return text === null ? err("no such file", 404)
            : new Response(text, { headers: { "content-type": "text/plain; charset=utf-8" } });
        }
        if (req.method === "PUT") {
          const ok = await writeSkillFile(name, rel, await req.text());
          return ok ? json({ ok: true }) : err("write failed", 400);
        }
      }
      const skillMatch = pathname.match(/^\/api\/skills\/([^/]+)$/);
      if (skillMatch) {
        const name = decodeURIComponent(skillMatch[1]);
        if (req.method === "GET") {
          const skill = await getSkill(name);
          return skill ? json(skill) : err("no such skill", 404);
        }
        if (req.method === "DELETE") {
          return (await deleteSkill(name)) ? json({ ok: true }) : err("delete failed", 404);
        }
      }

      if (pathname === "/api/config/app") {
        if (req.method === "GET") return json(await getAppConfig());
        if (req.method === "PUT") {
          const next = await setAppConfig(await req.json());
          invalidateUsageCaches(); // renewalDay feeds plan + month widgets
          return json(next);
        }
      }
      if (pathname === "/api/config/settings") {
        if (req.method === "GET") return new Response(await readSettings(), { headers: { "content-type": "application/json" } });
        if (req.method === "PUT") {
          try { await writeSettings(await req.text()); } catch { return err("invalid JSON"); }
          return json({ ok: true });
        }
      }
      if (pathname === "/api/config/claude-md") {
        if (req.method === "GET") return new Response(await readClaudeMd(), { headers: { "content-type": "text/markdown" } });
        if (req.method === "PUT") { await writeClaudeMd(await req.text()); return json({ ok: true }); }
      }

      if (pathname.startsWith("/api/") || pathname.startsWith("/ws/")) return err("not found", 404);
      return serveStatic(pathname);
    } catch (e) {
      console.error(`[${req.method} ${pathname}]`, e);
      return err(e instanceof Error ? e.message : "internal error", 500);
    }
  },

  websocket: {
    // default is 120s — background tabs go quiet longer than that; client
    // also pings every 30s as belt-and-suspenders
    idleTimeout: 960,
    open(ws) {
      const pty = ptySpawn("tmux", ["attach", "-t", `=${ws.data.sessionId}`], {
        name: "xterm-256color",
        cols: 220,
        rows: 50,
        env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG ?? "en_US.UTF-8" },
      });
      ws.data.pty = pty;
      pty.onData(chunk => {
        try { ws.send(chunk); } catch { /* socket gone */ }
      });
      pty.onExit(() => {
        try { ws.close(1000, "session ended"); } catch { /* already closed */ }
      });
    },
    message(ws, msg) {
      const pty = ws.data.pty;
      if (!pty) return;
      if (typeof msg === "string") {
        if (process.env.CC_WS_DEBUG) {
          require("node:fs").appendFileSync("/tmp/cc-ws-debug.log", JSON.stringify(msg) + "\n");
        }
        let m: any = null;
        try { m = JSON.parse(msg); } catch { /* raw input */ }
        if (m && typeof m === "object") {
          if (m.type === "resize" && m.cols > 0 && m.rows > 0) {
            pty.resize(Math.min(m.cols, 500), Math.min(m.rows, 200));
          } else if (m.type === "input" && typeof m.data === "string") {
            pty.write(m.data);
          } else if (m.type === "newline") {
            newlineIntoSession(ws.data.sessionId);
          }
          // anything else (e.g. keepalive pings) is deliberately ignored —
          // never let stray JSON get typed into the terminal
          return;
        }
        pty.write(msg);
      } else {
        pty.write(new TextDecoder().decode(msg));
      }
    },
    close(ws) {
      ws.data.pty?.kill(); // detaches this client; tmux session lives on
      ws.data.pty = undefined;
    },
  },
});

console.log(`Claude Command → http://localhost:${server.port} (loopback only)`);

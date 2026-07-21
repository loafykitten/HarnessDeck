import { err, harnessParam, json, text, type RouteHandler } from "../http";
import { getAppConfig, readMd, readSettings, setAppConfig, writeMd, writeSettings } from "./config";
import { invalidateClaudeMonthCache } from "../usage/claude";

export const configRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

  if (pathname === "/api/config/app") {
    if (req.method === "GET") return json(await getAppConfig());
    if (req.method === "PUT") {
      const { previous, next } = await setAppConfig(await req.json());
      if (previous.renewalDay !== next.renewalDay) invalidateClaudeMonthCache();
      return json(next);
    }
  }
  if (pathname === "/api/config/settings") {
    const h = harnessParam(url);
    if (!h) return err("unknown harness");
    if (req.method === "GET") return text(await readSettings(h));
    if (req.method === "PUT") {
      try { await writeSettings(h, await req.text()); } catch { return err("invalid syntax — not saved"); }
      return json({ ok: true });
    }
  }
  if (pathname === "/api/config/md") {
    const h = harnessParam(url);
    if (!h) return err("unknown harness");
    if (req.method === "GET") return text(await readMd(h), "text/markdown");
    if (req.method === "PUT") { await writeMd(h, await req.text()); return json({ ok: true }); }
  }

  return null;
};

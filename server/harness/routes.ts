import { err, harnessParam, json, type RouteHandler } from "../http";
import { harnessMeta } from "./registry";
import { updaters } from "./updates";

export const harnessRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

  if (pathname === "/api/harnesses" && req.method === "GET") {
    return json(harnessMeta());
  }

  // ---- Harness self-updates (claude update / codex update) ----
  if (pathname === "/api/updates" && req.method === "GET") {
    const force = url.searchParams.get("refresh") === "1";
    const [claude, codex] = await Promise.all([
      updaters.claude.getStatus(force),
      updaters.codex.getStatus(force),
    ]);
    return json({ claude, codex });
  }
  if (pathname === "/api/updates/apply" && req.method === "POST") {
    const harness = harnessParam(url);
    if (!harness) return err("unknown harness");
    const res = updaters[harness].start();
    return "error" in res ? err(res.error, 409) : json(res, 202);
  }

  return null;
};

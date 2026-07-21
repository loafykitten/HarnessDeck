import { err, json, text, type RouteHandler } from "../http";
import { deleteSkill, getSkill, listSkills, readSkillFile, syncSkill, writeSkillFile } from "./skills";
import { installFromUrl } from "./install";
import { generateSkill, getJob } from "./generate";

export const skillRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

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
  const syncMatch = pathname.match(/^\/api\/skills\/([^/]+)\/sync$/);
  if (syncMatch && req.method === "POST") {
    const body = await req.json();
    const res = await syncSkill(decodeURIComponent(syncMatch[1]), String(body.to ?? ""));
    return "error" in res ? err(res.error) : json(res);
  }
  const jobMatch = pathname.match(/^\/api\/skills\/jobs\/([^/]+)$/);
  if (jobMatch && req.method === "GET") {
    const job = getJob(jobMatch[1]);
    return job ? json(job) : err("no such job", 404);
  }
  const fileMatch = pathname.match(/^\/api\/skills\/([^/]+)\/file$/);
  if (fileMatch) {
    const name = decodeURIComponent(fileMatch[1]);
    const rel = url.searchParams.get("path") ?? "";
    if (req.method === "GET") {
      const body = await readSkillFile(name, rel);
      return body === null ? err("no such file", 404) : text(body);
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

  return null;
};

import { err, json, type RouteHandler } from "../http";
import { listProjects } from "./projects";
import { projectStack, projectTree } from "./files";

export const projectRoutes: RouteHandler = async (req, url) => {
  const { pathname } = url;

  if (pathname === "/api/projects" && req.method === "GET") {
    return json(await listProjects());
  }
  const treeMatch = pathname.match(/^\/api\/projects\/([^/]+)\/tree$/);
  if (treeMatch && req.method === "GET") {
    const fresh = url.searchParams.get("fresh") === "1";
    const tree = await projectTree(decodeURIComponent(treeMatch[1]), fresh);
    return tree ? json(tree) : err("no such project", 404);
  }
  const stackMatch = pathname.match(/^\/api\/projects\/([^/]+)\/stack$/);
  if (stackMatch && req.method === "GET") {
    const stack = await projectStack(decodeURIComponent(stackMatch[1]));
    return stack ? json(stack) : err("no such project", 404);
  }

  return null;
};

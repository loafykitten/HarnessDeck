import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { extname, join, sep } from "node:path";
import { DEV_DIR } from "../terminal/sessions";

export type TreeGitStatus = "tracked" | "untracked" | "ignored" | "none";

export interface TreeNode {
  name: string;
  path: string;
  kind: "dir" | "file";
  hidden: boolean;
  ext?: string;
  git: TreeGitStatus;
  children?: TreeNode[];
}

export interface ProjectTree {
  root: TreeNode;
  truncated: boolean;
  git: boolean;
}

const SKIP_DIRS = new Set([
  ".git", "node_modules", ".build", "dist", "build", "target",
  "DerivedData", "__pycache__", ".venv", "venv",
]);
const MAX_DEPTH = 8;
const MAX_ENTRIES = 5_000;
const CACHE_TTL = 15_000;

const treeCache = new Map<string, { at: number; value: ProjectTree }>();
const stackCache = new Map<string, { at: number; value: { stack: string[] } }>();

async function resolveProject(name: string): Promise<string | null> {
  if (!name || name.includes("/") || name.includes("..")) return null;
  try {
    const [base, dir] = await Promise.all([realpath(DEV_DIR), realpath(join(DEV_DIR, name))]);
    if (!dir.startsWith(base + sep)) return null;
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

async function gitFiles(dir: string, ...args: string[]): Promise<Set<string> | null> {
  try {
    const p = Bun.spawn(["git", "ls-files", "-z", ...args], {
      cwd: dir, stdout: "pipe", stderr: "pipe",
    });
    const [out, , code] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
      p.exited,
    ]);
    if (code !== 0) return null;
    return new Set(out.split("\0").filter(Boolean));
  } catch {
    return null;
  }
}

function sortNodes(nodes: TreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
      || a.name.localeCompare(b.name);
  });
}

function directoryPaths(files: Set<string> | null): Set<string> {
  const directories = new Set<string>();
  if (!files) return directories;
  for (const file of files) {
    const parts = file.split("/");
    parts.pop();
    directories.add("");
    while (parts.length > 0) {
      directories.add(parts.join("/"));
      parts.pop();
    }
  }
  return directories;
}

function directoryGit(path: string, inGit: boolean, tracked: Set<string>, untracked: Set<string>): TreeGitStatus {
  if (!inGit) return "none";
  if (tracked.has(path)) return "tracked";
  if (untracked.has(path)) return "untracked";
  return "ignored";
}

export async function projectTree(name: string, fresh = false): Promise<ProjectTree | null> {
  const dir = await resolveProject(name);
  if (!dir) return null;

  const hit = treeCache.get(dir);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const [tracked, untracked] = await Promise.all([
    gitFiles(dir),
    gitFiles(dir, "--others", "--exclude-standard"),
  ]);
  const inGit = tracked !== null && untracked !== null;
  const trackedDirs = directoryPaths(tracked);
  const untrackedDirs = directoryPaths(untracked);
  let count = 0;
  let truncated = false;

  async function walk(absDir: string, relDir: string, depth: number): Promise<TreeNode[]> {
    let entries;
    try {
      entries = await readdir(absDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const nodes: TreeNode[] = [];
    for (const entry of entries) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) continue;
      if (count >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      count++;

      const path = relDir ? join(relDir, entry.name) : entry.name;
      if (entry.isDirectory()) {
        let children: TreeNode[] = [];
        if (depth < MAX_DEPTH) children = await walk(join(absDir, entry.name), path, depth + 1);
        else truncated = true;
        nodes.push({
          name: entry.name,
          path,
          kind: "dir",
          hidden: entry.name.startsWith("."),
          git: directoryGit(path, inGit, trackedDirs, untrackedDirs),
          children,
        });
      } else {
        const extension = extname(entry.name).slice(1).toLowerCase();
        const git: TreeGitStatus = !inGit ? "none"
          : tracked.has(path) ? "tracked"
          : untracked.has(path) ? "untracked"
          : "ignored";
        nodes.push({
          name: entry.name,
          path,
          kind: "file",
          hidden: entry.name.startsWith("."),
          ...(extension ? { ext: extension } : {}),
          git,
        });
      }
    }
    sortNodes(nodes);
    return nodes;
  }

  const children = await walk(dir, "", 0);
  const root: TreeNode = {
    name,
    path: "",
    kind: "dir",
    hidden: name.startsWith("."),
    git: directoryGit("", inGit, trackedDirs, untrackedDirs),
    children,
  };
  const value = { root, truncated, git: inGit };
  treeCache.set(dir, { at: Date.now(), value });
  return value;
}

const OBVIOUS_DIRS = new Set(["web", "app", "server"]);
const PACKAGE_TECH: [string, string][] = [
  ["svelte", "Svelte"],
  ["react", "React"],
  ["vue", "Vue"],
  ["next", "Next.js"],
  ["vite", "Vite"],
  ["typescript", "TypeScript"],
  ["tailwindcss", "Tailwind"],
  ["electron", "Electron"],
  ["express", "Express"],
  ["hono", "Hono"],
  ["fastify", "Fastify"],
];

export async function projectStack(name: string): Promise<{ stack: string[] } | null> {
  const dir = await resolveProject(name);
  if (!dir) return null;

  const hit = stackCache.get(dir);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.value;

  const scopes = [dir];
  let rootEntries;
  try {
    rootEntries = await readdir(dir, { withFileTypes: true });
  } catch {
    return { stack: [] };
  }
  for (const entry of rootEntries) {
    if (entry.isDirectory() && OBVIOUS_DIRS.has(entry.name)) scopes.push(join(dir, entry.name));
  }

  const namesByScope = await Promise.all(scopes.map(async scope =>
    new Set((await readdir(scope, { withFileTypes: true })).map(entry => entry.name))));
  const allNames = new Set(namesByScope.flatMap(names => [...names]));
  const packageDeps = new Set<string>();
  let hasPackage = false;

  for (let i = 0; i < scopes.length; i++) {
    if (!namesByScope[i].has("package.json")) continue;
    hasPackage = true;
    try {
      const pkg = JSON.parse(await readFile(join(scopes[i], "package.json"), "utf8"));
      for (const group of [pkg.dependencies, pkg.devDependencies, pkg.peerDependencies, pkg.optionalDependencies]) {
        if (!group || typeof group !== "object") continue;
        for (const dep of Object.keys(group)) packageDeps.add(dep);
      }
    } catch { /* malformed package metadata should not hide other detections */ }
  }

  const stack: string[] = [];
  const add = (technology: string) => { if (!stack.includes(technology)) stack.push(technology); };
  if (hasPackage) {
    const hasBunLock = allNames.has("bun.lock") || allNames.has("bun.lockb");
    const hasOtherLock = allNames.has("package-lock.json") || allNames.has("yarn.lock") || allNames.has("pnpm-lock.yaml");
    add(hasBunLock && !hasOtherLock ? "Bun" : "Node.js");
    for (const [dep, technology] of PACKAGE_TECH) {
      if (packageDeps.has(dep)) add(technology);
    }
  }
  if (allNames.has("tsconfig.json")) add("TypeScript");

  const FILE_TECH: [string, (file: string) => boolean][] = [
    ["Rust", file => file === "Cargo.toml"],
    ["Go", file => file === "go.mod"],
    ["Python", file => file === "pyproject.toml" || file === "requirements.txt"],
    ["Swift", file => file === "Package.swift" || file.endsWith(".xcodeproj")],
    ["Ruby", file => file === "Gemfile"],
    ["Java/Kotlin", file => file === "pom.xml" || file.startsWith("build.gradle")],
    ["Docker", file => file === "Dockerfile" || file.startsWith("docker-compose")],
    ["Terraform", file => file.endsWith(".tf")],
  ];
  for (const [technology, matches] of FILE_TECH) {
    if ([...allNames].some(matches)) add(technology);
  }

  const value = { stack };
  stackCache.set(dir, { at: Date.now(), value });
  return value;
}

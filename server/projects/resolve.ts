import { realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DEV_DIR } from "../paths";

/** Syntactic check only: a bare directory name, no separators or dot-dirs. */
export function isProjectName(name: unknown): name is string {
  return typeof name === "string" && !!name && name !== "." && name !== ".." && name === basename(name);
}

/** A project is a direct child directory of ~/Developer, named bare. Checked
    on the realpath so `..` or a symlink can't point a harness (or a file read)
    somewhere else. Returns the resolved directory, or null. */
export async function resolveProjectDir(name: string): Promise<string | null> {
  if (!isProjectName(name)) return null;
  try {
    const [base, dir] = await Promise.all([realpath(DEV_DIR), realpath(join(DEV_DIR, name))]);
    if (dirname(dir) !== base) return null;
    return (await stat(dir)).isDirectory() ? dir : null;
  } catch {
    return null;
  }
}

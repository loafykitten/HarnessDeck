import { readdir } from "node:fs/promises";
import { extname, join } from "node:path";
import { gzipSync } from "node:zlib";

const DIST = join(import.meta.dir, "..", "dist");
const COMPRESS_EXTENSIONS = new Set([".js", ".css", ".svg", ".html"]);
const MIN_BYTES = 1024;

async function compressDir(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.map(async entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return compressDir(path);
    if (!COMPRESS_EXTENSIONS.has(extname(entry.name))) return;
    const contents = await Bun.file(path).arrayBuffer();
    if (contents.byteLength < MIN_BYTES) return;
    await Bun.write(path + ".gz", gzipSync(contents, { level: 9 }));
  }));
}

await compressDir(DIST);

import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

export const CHAT_PASTE_DIR = join(homedir(), "Library", "Caches", "HarnessDeck", "pastes");
export const MAX_CHAT_IMAGE_BYTES = 32 * 1024 * 1024;

export type ChatImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const EXTENSIONS: Record<ChatImageMediaType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

export function chatImageMediaType(path: string): ChatImageMediaType {
  const ext = extname(path).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".gif") return "image/gif";
  if (ext === ".webp") return "image/webp";
  return "image/png";
}

export function chatImageExtension(contentType: string): string | null {
  return EXTENSIONS[contentType.split(";", 1)[0].trim().toLowerCase() as ChatImageMediaType] ?? null;
}

export async function saveChatImage(blob: Blob, extension: string): Promise<string> {
  await mkdir(CHAT_PASTE_DIR, { recursive: true });
  const path = join(CHAT_PASTE_DIR, `paste-${Date.now()}-${randomUUID()}${extension}`);
  await Bun.write(path, blob);
  void pruneOldChatImages().catch(() => {});
  return path;
}

export async function validateChatImagePaths(paths: string[]): Promise<string[]> {
  if (!paths.length) return [];
  const pasteDir = await realpath(CHAT_PASTE_DIR);
  return Promise.all(paths.map(async path => {
    const resolved = resolve(path);
    if (dirname(resolved) !== resolve(CHAT_PASTE_DIR) || !basename(resolved).startsWith("paste-")) {
      throw new Error("invalid image attachment");
    }
    const actual = await realpath(resolved);
    const info = await stat(actual);
    if (dirname(actual) !== pasteDir || !info.isFile() || info.size === 0 || info.size > MAX_CHAT_IMAGE_BYTES) {
      throw new Error("invalid image attachment");
    }
    const ext = extname(actual).toLowerCase();
    if (![".png", ".jpg", ".jpeg", ".gif", ".webp"].includes(ext)) {
      throw new Error("unsupported image attachment");
    }
    return actual;
  }));
}

async function pruneOldChatImages(): Promise<void> {
  const cutoff = Date.now() - 24 * 60 * 60_000;
  const entries = await readdir(CHAT_PASTE_DIR, { withFileTypes: true });
  await Promise.all(entries.flatMap(entry => {
    if (!entry.isFile() || !entry.name.startsWith("paste-")) return [];
    const path = join(CHAT_PASTE_DIR, entry.name);
    return [stat(path).then(info => info.mtimeMs < cutoff ? unlink(path) : undefined)];
  }));
}

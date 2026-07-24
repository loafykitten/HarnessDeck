import { homedir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { mkdir, readdir, realpath, stat, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";

// Chat pastes live in their own subdirectory, apart from terminal pastes:
// terminal names are guessable (`paste-<timestamp>`, no uuid) so the GET
// route must never be able to reach them, and the terminal pruner deletes
// any `paste-*` file in ITS directory after 24h (it skips subdirectories),
// which would break our 30-day retention.
export const CHAT_PASTE_DIR = join(homedir(), "Library", "Caches", "HarnessDeck", "pastes", "chat");
// Chat images are base64-inlined into API requests (unlike terminal pastes,
// which only pass a file path). The Claude API caps images at 10 MB encoded
// (≈7.5 MB raw) and requests at 32 MB total, and anything over 2576px long
// edge is downscaled server-side anyway — 5 MB raw keeps multi-image
// messages comfortably inside both limits.
export const MAX_CHAT_IMAGE_BYTES = 5 * 1024 * 1024;

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

/**
 * Resolve a paste basename (as carried on a `block` event) to an on-disk path,
 * or null when it fails validation. Reuses the same hardened checks as sending.
 */
export async function resolveChatImage(name: string): Promise<string | null> {
  if (!name || basename(name) !== name) return null;
  try {
    const [path] = await validateChatImagePaths([join(CHAT_PASTE_DIR, name)]);
    return path ?? null;
  } catch {
    return null;
  }
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

// Pastes are rendered inline in the chat feed, so they have to outlive the
// message that referenced them — a 24h window made older transcripts 404.
const IMAGE_RETENTION_MS = 30 * 24 * 60 * 60_000;

async function pruneOldChatImages(): Promise<void> {
  const cutoff = Date.now() - IMAGE_RETENTION_MS;
  const entries = await readdir(CHAT_PASTE_DIR, { withFileTypes: true });
  await Promise.all(entries.flatMap(entry => {
    if (!entry.isFile() || !entry.name.startsWith("paste-")) return [];
    const path = join(CHAT_PASTE_DIR, entry.name);
    return [stat(path).then(info => info.mtimeMs < cutoff ? unlink(path) : undefined)];
  }));
}

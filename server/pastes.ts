import { readdir, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { err } from "./http";

/** Image pastes, shared by the terminal and chat upload routes. Each caller
    keeps its own policy — size cap, naming, retention, unknown types. */

export type ImageMediaType = "image/png" | "image/jpeg" | "image/gif" | "image/webp";

const EXTENSIONS: Record<ImageMediaType, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

/** File extension for an image Content-Type (parameters ignored), or null
    when it isn't a type we accept. */
export function imageExtension(contentType: string): string | null {
  return EXTENSIONS[contentType.split(";", 1)[0].trim().toLowerCase() as ImageMediaType] ?? null;
}

/** The upload body, or the error response rejecting it. Content-Length is
    checked first so an oversized paste is refused before it's buffered, then
    the real size — the header is advisory and absent on chunked bodies. */
export async function readImageUpload(req: Request, maxBytes: number, tooLarge: string): Promise<Blob | Response> {
  const contentLength = Number(req.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) return err(tooLarge, 413);
  const blob = await req.blob();
  if (blob.size === 0) return err("empty body");
  if (blob.size > maxBytes) return err(tooLarge, 413);
  return blob;
}

/** Delete `paste-*` files in `dir` older than `maxAgeMs`. Top-level files
    only: a subdirectory (chat pastes live in one) keeps its own retention. */
export async function pruneOldPastes(dir: string, maxAgeMs: number): Promise<void> {
  const cutoff = Date.now() - maxAgeMs;
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(entries.flatMap(entry => {
    if (!entry.isFile() || !entry.name.startsWith("paste-")) return [];
    const path = join(dir, entry.name);
    return [stat(path).then(info => info.mtimeMs < cutoff ? unlink(path) : undefined)];
  }));
}

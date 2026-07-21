import type { NewsVendor } from "./types";

/* ---------------- fetch + parse helpers ---------------- */

interface Validators { etag: string | null; lastModified: string | null }
const validators = new Map<string, Validators>();
const MAX_VALIDATORS = 128;

/** conditional=false opts a request out of the validator cache entirely: for
    one-shot URLs (HN's timestamped queries, per-item title fetches) storing
    validators just FIFO-evicts the stable feeds' entries, and the moonshot
    changelog hashes body content precisely because it distrusts origin
    change signals — a stale 304 there would swallow a real update. */
export async function fetchText(url: string, timeoutMs = 15_000, conditional = true): Promise<string | null> {
  const known = conditional ? validators.get(url) : undefined;
  const headers: Record<string, string> = { "user-agent": "HarnessDeck/0.1 (news ticker)" };
  if (known?.etag) headers["if-none-match"] = known.etag;
  if (known?.lastModified) headers["if-modified-since"] = known.lastModified;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers,
  });
  if (res.status === 304) return null;
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  if (conditional) {
    if (!validators.has(url) && validators.size >= MAX_VALIDATORS) {
      validators.delete(validators.keys().next().value!);
    }
    validators.set(url, {
      etag: res.headers.get("etag"),
      lastModified: res.headers.get("last-modified"),
    });
  }
  return res.text();
}

export async function fetchJSON<T>(url: string, timeoutMs = 15_000, conditional = true): Promise<T | null> {
  const text = await fetchText(url, timeoutMs, conditional);
  return text === null ? null : JSON.parse(text) as T;
}

export function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[(.*?)\]\]>/gs, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#x27;/gi, "'")
    .replace(/&nbsp;/g, " ")
    .trim();
}

export function blocks(xml: string, tag: string): string[] {
  return [...xml.matchAll(new RegExp(`<${tag}[\\s>][\\s\\S]*?</${tag}>`, "g"))].map(m => m[0]);
}

export function tagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return m ? decode(m[1]) : null;
}

export function truncate(s: string, n = 90): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}

export const VENDOR_WORDS: [NewsVendor, RegExp][] = [
  ["anthropic", /anthropic|claude/i],
  ["openai", /openai|chatgpt|\bgpt-?\d/i],
  ["deepseek", /deepseek/i],
  ["moonshot", /moonshot|kimi/i],
  ["zai", /\bz\.ai\b|zhipu|\bglm\b|\bglm-/i],
];

export function vendorOf(text: string): NewsVendor | null {
  for (const [v, re] of VENDOR_WORDS) if (re.test(text)) return v;
  return null;
}

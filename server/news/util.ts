import type { NewsVendor } from "./types";

/* ---------------- fetch + parse helpers ---------------- */

export async function fetchText(url: string, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { "user-agent": "HarnessDeck/0.1 (news ticker)" },
  });
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return res.text();
}

export async function fetchJSON<T>(url: string, timeoutMs = 15_000): Promise<T> {
  return JSON.parse(await fetchText(url, timeoutMs)) as T;
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

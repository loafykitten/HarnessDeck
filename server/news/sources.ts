import type { Candidate, NewsItem, NewsVendor } from "./types";
import { blocks, decode, fetchJSON, fetchText, tagText, truncate, VENDOR_WORDS, vendorOf } from "./util";

/* ---------------- layer 1: status pages (no LLM, fast tier) ---------------- */

const STATUS_PAGES: { vendor: NewsVendor; label: string; url: string; page: string }[] = [
  { vendor: "anthropic", label: "Anthropic", url: "https://status.anthropic.com/api/v2/summary.json", page: "https://status.anthropic.com" },
  { vendor: "openai", label: "OpenAI", url: "https://status.openai.com/api/v2/summary.json", page: "https://status.openai.com" },
  { vendor: "moonshot", label: "Moonshot", url: "https://status.moonshot.cn/api/v2/summary.json", page: "https://status.moonshot.cn" },
];

interface StatusIncident { id: string; name: string; status: string; impact: string; created_at: string; started_at?: string; shortlink?: string }

// active incidents by item id; resolved ones linger for 12h so "back to normal" is visible
export let statusActive: NewsItem[] = [];
export let statusResolved: NewsItem[] = [];

export async function refreshStatus(): Promise<void> {
  const results = await Promise.allSettled(STATUS_PAGES.map(async p => {
    const sum = await fetchJSON<{ incidents?: StatusIncident[] }>(p.url);
    if (sum === null) return null;
    return (sum.incidents ?? []).map<NewsItem>(inc => ({
      id: `st:${p.vendor}:${inc.id}`,
      vendor: p.vendor,
      kind: "outage",
      headline: truncate(`${p.label} status: ${inc.name}`),
      url: inc.shortlink || p.page,
      at: Date.parse(inc.started_at ?? inc.created_at) || Date.now(),
    }));
  }));
  // a failed page keeps its previous incidents rather than clearing them
  const next: NewsItem[] = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value !== null) next.push(...r.value);
    else next.push(...statusActive.filter(it => it.vendor === STATUS_PAGES[i].vendor));
  });
  const nextIds = new Set(next.map(it => it.id));
  const now = Date.now();
  for (const gone of statusActive) {
    // a flapping incident may resolve twice inside the 12h window — one entry
    if (!nextIds.has(gone.id) && !statusResolved.some(r => r.id === gone.id + ":ok")) {
      statusResolved.push({
        ...gone, id: gone.id + ":ok", kind: "resolved",
        headline: truncate(gone.headline.replace(/ status: /, " resolved: ")), at: now,
      });
    }
  }
  statusResolved = statusResolved.filter(it => now - it.at < 12 * 3600_000);
  statusActive = next;
}

/* ---------------- layer 1: feeds (RSS/Atom + HN, medium tier) ---------------- */

const RSS_FEEDS: { vendor: NewsVendor | null; url: string; atom: boolean }[] = [
  { vendor: "openai", url: "https://openai.com/news/rss.xml", atom: false },
  // high-signal aggregator; keyword-filtered down to the tracked labs
  { vendor: null, url: "https://simonwillison.net/atom/everything/", atom: true },
];

function parseFeed(xml: string, atom: boolean): { title: string; url: string; at: number }[] {
  return blocks(xml, atom ? "entry" : "item").flatMap(b => {
    const title = tagText(b, "title");
    const url = atom
      ? b.match(/<link[^>]*href="([^"]+)"/)?.[1] ?? null
      : tagText(b, "link");
    const at = Date.parse(tagText(b, atom ? "updated" : "pubDate") ?? "") || 0;
    return title && url ? [{ title, url, at }] : [];
  });
}

export async function pollRss(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const results = await Promise.allSettled(RSS_FEEDS.map(async f => {
    const cutoff = Date.now() - 72 * 3600_000;
    const xml = await fetchText(f.url);
    if (xml === null) return;
    for (const e of parseFeed(xml, f.atom)) {
      if (e.at < cutoff) continue;
      const vendor = f.vendor ?? vendorOf(e.title);
      if (!vendor) continue;
      out.push({ id: `rss:${e.url}`, vendor, kind: "news", title: e.title, url: e.url, at: e.at });
    }
  }));
  results.forEach((r, i) => { if (r.status === "rejected") console.error("news rss", RSS_FEEDS[i].url, r.reason); });
  return out;
}

/* Algolia's full-text search requires ALL query terms (no OR operator), so
   each alias is its own request, merged by objectID. The title must also
   re-match the vendor's own regex — Algolia matches on page text too, and
   generic aliases ("moonshot") would otherwise drag in unrelated stories. */
const HN_QUERIES: { vendor: NewsVendor; q: string }[] = [
  { vendor: "anthropic", q: "anthropic" },
  { vendor: "anthropic", q: "claude" },
  { vendor: "openai", q: "openai" },
  { vendor: "openai", q: "chatgpt" },
  { vendor: "deepseek", q: "deepseek" },
  { vendor: "moonshot", q: "kimi" },
  { vendor: "moonshot", q: "moonshot" },
  { vendor: "zai", q: "glm" },
  { vendor: "zai", q: "zhipu" },
  { vendor: "zai", q: "z.ai" },
];

interface HNHit { objectID: string; title: string; url: string | null; points: number; created_at_i: number }

export async function pollHN(): Promise<Candidate[]> {
  const seen = new Map<string, Candidate>();
  const since = Math.floor(Date.now() / 1000) - 48 * 3600;
  const results = await Promise.allSettled(HN_QUERIES.map(async ({ vendor, q }) => {
    const u = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(q)}` +
      `&tags=story&numericFilters=points%3E100,created_at_i%3E${since}&hitsPerPage=10`;
    const vendorRe = VENDOR_WORDS.find(([v]) => v === vendor)![1];
    const data = await fetchJSON<{ hits: HNHit[] }>(u, 15_000, false); // `since` makes u one-shot
    if (data === null) return;
    for (const h of data.hits) {
      if (!vendorRe.test(h.title)) continue;
      if (!seen.has(h.objectID)) seen.set(h.objectID, {
        id: `hn:${h.objectID}`, vendor, kind: "news", title: h.title,
        url: h.url ?? `https://news.ycombinator.com/item?id=${h.objectID}`,
        at: h.created_at_i * 1000,
      });
    }
  }));
  results.forEach((r, i) => { if (r.status === "rejected") console.error("news hn", HN_QUERIES[i].q, r.reason); });
  return [...seen.values()];
}

/* ---------------- layer 1: HF weights + sitemap diffs (slow tier) ---------------- */

const HF_ORGS: { vendor: NewsVendor; org: string }[] = [
  { vendor: "openai", org: "openai" },
  { vendor: "zai", org: "zai-org" },
  { vendor: "moonshot", org: "moonshotai" },
  { vendor: "deepseek", org: "deepseek-ai" },
];

export async function pollHF(): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const cutoff = Date.now() - 7 * 86400_000;
  const results = await Promise.allSettled(HF_ORGS.map(async ({ vendor, org }) => {
    const u = `https://huggingface.co/api/models?author=${org}&sort=createdAt&direction=-1&limit=5`;
    const models = await fetchJSON<{ id: string; createdAt: string }[]>(u);
    if (models === null) return;
    for (const m of models) {
      const at = Date.parse(m.createdAt) || 0;
      if (at < cutoff) continue;
      out.push({
        id: `hf:${m.id}`, vendor, kind: "release",
        title: `New model weights on Hugging Face: ${m.id}`,
        url: `https://huggingface.co/${m.id}`, at,
      });
    }
  }));
  results.forEach((r, i) => { if (r.status === "rejected") console.error("news hf", HF_ORGS[i].org, r.reason); });
  return out;
}

/* Vendors with no feed (Anthropic news, Z.ai/DeepSeek/Moonshot docs) publish
   sitemaps: a new <loc> — or a bumped <lastmod> on a changelog page — is the
   change signal. First sighting of a sitemap seeds `seen` without emitting,
   so a fresh install doesn't replay years of archives onto the ticker. */
const SITEMAPS: { vendor: NewsVendor; url: string; match: RegExp }[] = [
  { vendor: "anthropic", url: "https://www.anthropic.com/sitemap.xml", match: /\/news\/[^/]+$/ },
  { vendor: "zai", url: "https://docs.z.ai/sitemap.xml", match: /release-notes/ },
  { vendor: "deepseek", url: "https://api-docs.deepseek.com/sitemap.xml", match: /\/news\/[^/]+$/ },
];

export async function pollSitemaps(seenSet: Set<string>): Promise<Candidate[]> {
  const out: Candidate[] = [];
  const results = await Promise.allSettled(SITEMAPS.map(async s => {
    const seeded = [...seenSet].some(id => id.startsWith(`sm:${s.vendor}:`));
    const xml = await fetchText(s.url, 20_000);
    if (xml === null) return;
    const smHost = new URL(s.url).hostname;
    for (const b of blocks(xml, "url")) {
      const loc = tagText(b, "loc");
      if (!loc || !s.match.test(loc)) continue;
      // resolveTitles() fetches this URL server-side: pin it to the sitemap's
      // own https origin so a poisoned entry can't point the fetch elsewhere
      try { const u = new URL(loc); if (u.protocol !== "https:" || u.hostname !== smHost) continue; }
      catch { continue; }
      const lastmod = tagText(b, "lastmod");
      const id = `sm:${s.vendor}:${loc}@${lastmod ?? "0"}`;
      if (seenSet.has(id)) continue;
      if (!seeded) { seenSet.add(id); continue; } // silent seed on first sighting
      const at = (lastmod && Date.parse(lastmod)) || Date.now();
      // an unseen-but-old page is a seen-list eviction or sitemap reshuffle,
      // not news — reseed it silently rather than resurfacing it
      if (Date.now() - at > 30 * 86400_000) { seenSet.add(id); continue; }
      const slug = decodeURIComponent(loc.replace(/\/$/, "").split("/").pop() ?? loc).replace(/[-_]/g, " ");
      out.push({ id, vendor: s.vendor, kind: "news", title: slug, url: loc, at, fetchTitle: true });
    }
  }));
  results.forEach((r, i) => { if (r.status === "rejected") console.error("news sitemap", SITEMAPS[i].url, r.reason); });
  return out;
}

/* Moonshot's platform sitemap holds a single marketing URL (and 301s to
   platform.kimi.ai), so the changelog is watched by content hash instead:
   a changed page emits one generic item pointing at the changelog. */
const MOONSHOT_CHANGELOG = "https://platform.moonshot.ai/docs/changelog";

export async function pollMoonshotChangelog(seenSet: Set<string>): Promise<Candidate[]> {
  const seeded = [...seenSet].some(id => id.startsWith("smh:moonshot:"));
  const html = await fetchText(MOONSHOT_CHANGELOG, 20_000, false); // hash the body; never trust a 304
  if (html === null) return [];
  const text = decode(html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ""));
  const id = `smh:moonshot:${Bun.hash(text).toString(16)}`;
  if (seenSet.has(id)) return [];
  if (!seeded) { seenSet.add(id); return []; }
  return [{
    id, vendor: "moonshot", kind: "news",
    title: "Moonshot platform changelog updated",
    url: MOONSHOT_CHANGELOG, at: Date.now(),
  }];
}

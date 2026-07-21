/* AI-lab news for the ticker. Two layers:
   1. Deterministic pollers (status-page JSON, RSS/Atom, HN Algolia, Hugging
      Face model API, sitemap diffs) — zero tokens, tiered TTLs, driven lazily
      by the client's /api/news polls like the greeting module. (sources.ts)
   2. A Neuralwatt synthesis pass (OpenAI-compatible API) that only runs when
      a poller surfaces something unseen, and only over those new items.
      (synthesis.ts)
   Status incidents skip synthesis entirely — they're already structured, and
   outages are the one category where minutes matter. */

export type NewsVendor = "anthropic" | "openai" | "zai" | "moonshot" | "deepseek";
export type NewsKind = "release" | "outage" | "resolved" | "news";

export interface NewsItem {
  id: string;
  vendor: NewsVendor;
  kind: NewsKind;
  headline: string;
  url: string;
  at: number; // publication/detection time, epoch ms
}

export interface NewsPayload {
  items: NewsItem[];
  updatedAt: number | null;
}

export interface Candidate {
  id: string;
  vendor: NewsVendor;
  kind: NewsKind; // synthesis may override release/news
  title: string;
  url: string;
  at: number;
  fetchTitle?: boolean; // sitemap hits arrive as bare URLs
}

import type { Candidate, NewsPayload } from "./types";
import { ensureLoaded, locked, mergeSeen, save, MAX_ITEMS } from "./state";
import {
  pollHF, pollHN, pollMoonshotChangelog, pollRss, pollSitemaps,
  refreshStatus, statusActive, statusResolved,
} from "./sources";
import { synthesize } from "./synthesis";

/* ---------------- orchestration ---------------- */

const MAX_SYNTH_BATCH = 25; // first run can surface a big backfill; cap the tail off

const TIER_TTL = { status: 3 * 60_000, feeds: 15 * 60_000, slow: 45 * 60_000 };
const lastRun = { status: 0, feeds: 0, slow: 0 };
const inFlight = { status: false, feeds: false, slow: false };

async function ingest(cands: Candidate[]): Promise<void> {
  return locked(async () => {
    const st = await ensureLoaded();
    const seenSet = new Set(st.seen);
    const fresh = cands
      .filter(c => /^https?:\/\//i.test(c.url)) // feed-supplied URLs land in hrefs
      .filter(c => !seenSet.has(c.id))
      .sort((a, b) => b.at - a.at)
      .slice(0, MAX_SYNTH_BATCH);
    if (fresh.length) {
      const items = await synthesize(fresh, st.items);
      st.items = [...items, ...st.items]
        .filter((it, i, arr) => arr.findIndex(x => x.id === it.id) === i)
        .sort((a, b) => b.at - a.at)
        .slice(0, MAX_ITEMS);
      st.updatedAt = Date.now();
    }
    for (const c of cands) seenSet.add(c.id);
    const nextSeen = mergeSeen(st.seen, seenSet);
    const seenChanged = nextSeen.length !== st.seen.length
      || nextSeen.some((id, i) => id !== st.seen[i]);
    st.seen = nextSeen;
    if (fresh.length || seenChanged) await save();
  });
}

function kick(tier: keyof typeof TIER_TTL, run: () => Promise<void>): void {
  if (inFlight[tier] || Date.now() - lastRun[tier] < TIER_TTL[tier]) return;
  inFlight[tier] = true;
  run()
    .catch(e => console.error(`news ${tier}`, e))
    .finally(() => {
      // stamp on failure too — otherwise every 60s client poll re-runs a
      // broken tier (and re-bills its synthesis call) until it heals
      lastRun[tier] = Date.now();
      inFlight[tier] = false;
    });
}

/** Non-blocking like the greeting: serves what's cached and lets the client's
    next 60s poll pick up whatever the background refresh found. */
export async function getNews(): Promise<NewsPayload> {
  const st = await ensureLoaded();
  kick("status", refreshStatus);
  kick("feeds", async () => {
    const [rss, hn] = await Promise.all([pollRss(), pollHN()]);
    await ingest([...rss, ...hn]);
  });
  kick("slow", async () => {
    const seenSet = new Set((await ensureLoaded()).seen);
    const initialSeen = new Set(seenSet);
    const hfPending = pollHF().then(
      value => ({ value }),
      error => ({ error }),
    );
    const [sm, mc] = await Promise.all([
      pollSitemaps(seenSet),
      pollMoonshotChangelog(seenSet)
        .catch(e => { console.error("news moonshot", e); return [] as Candidate[]; }),
    ]);
    // seeding mutates seenSet even when nothing is emitted — persist it
    const seedChanged = seenSet.size !== initialSeen.size
      || [...seenSet].some(id => !initialSeen.has(id));
    if (seedChanged) {
      await locked(async () => {
        const cur = await ensureLoaded();
        cur.seen = mergeSeen(cur.seen, seenSet);
        await save();
      });
    }
    const hf = await hfPending;
    if ("error" in hf) throw hf.error;
    await ingest([...hf.value, ...sm, ...mc]);
  });
  // active outages lead; everything else newest-first; a flapping incident
  // could otherwise repeat an id, which would crash the keyed {#each}
  const rest = [...statusResolved, ...st.items].sort((a, b) => b.at - a.at);
  const items = [...statusActive.sort((a, b) => b.at - a.at), ...rest]
    .filter((it, i, arr) => arr.findIndex(x => x.id === it.id) === i)
    .slice(0, 30);
  return { items, updatedAt: st.updatedAt };
}

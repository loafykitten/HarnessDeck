<script lang="ts">
  import { app } from "../lib/state.svelte";
  import { fmtAgo, type NewsVendor } from "../lib/api";

  const VENDOR_LABEL: Record<NewsVendor, string> = {
    anthropic: "Anthropic", openai: "OpenAI", zai: "Z.ai",
    moonshot: "Moonshot", deepseek: "DeepSeek",
  };

  let open = $state(false);
  const items = $derived(app.news?.items ?? []);
  // a sparse list leaves a dead gap in the loop — repeat until a group is
  // comfortably wider than any viewport
  const loop = $derived(
    items.length ? Array.from({ length: Math.max(1, Math.ceil(10 / items.length)) }, () => items).flat() : [],
  );
  // crawl speed scales with content so a short list doesn't whip past
  const dur = $derived(Math.max(36, loop.length * 7));

  function age(at: number): string {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
</script>

{#if items.length}
  <div class="tk glass">
    <button class="tk-cap" title="News history"
      onclick={e => { e.stopPropagation(); open = !open; }}>
      <span class="live-dot"></span> Wire <span class="tk-chev" class:up={open}>▾</span>
    </button>
    <div class="tk-view">
      <div class="tk-track" style="--tk-dur:{dur}s">
        <!-- two identical groups so the -50% translate loops seamlessly -->
        {#each [0, 1] as copy (copy)}
          <div class="tk-group" aria-hidden={copy === 1}>
            {#each loop as it, i (`${copy}:${i}:${it.id}`)}
              <a class="tk-item" class:outage={it.kind === "outage"}
                href={it.url} target="_blank" rel="noreferrer" tabindex={copy === 1 ? -1 : 0}>
                {#if it.kind === "outage" || it.kind === "resolved"}
                  <span class="tk-dot {it.kind}"></span>
                {/if}
                <span class="tk-src {it.vendor}">{VENDOR_LABEL[it.vendor] ?? it.vendor}</span>
                <span class="tk-head">{it.headline}</span>
                <span class="tk-age mono">{age(it.at)}</span>
              </a>
              <span class="tk-sep"></span>
            {/each}
          </div>
        {/each}
      </div>
    </div>
    {#if app.news?.updatedAt}
      <span class="tk-upd mono">{fmtAgo(app.news.updatedAt)}</span>
    {/if}

    {#if open}
      <div class="tk-pop">
        {#each items as it (it.id)}
          <a class="tk-row" href={it.url} target="_blank" rel="noreferrer">
            {#if it.kind === "outage" || it.kind === "resolved"}
              <span class="tk-dot {it.kind}"></span>
            {/if}
            <span class="tk-src {it.vendor}">{VENDOR_LABEL[it.vendor] ?? it.vendor}</span>
            <span class="tk-row-head">{it.headline}</span>
            <span class="tk-age mono">{age(it.at)}</span>
          </a>
        {/each}
      </div>
    {/if}
  </div>
{/if}

<svelte:window onclick={() => { if (open) open = false; }} />

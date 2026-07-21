<script lang="ts">
  import { onMount } from "svelte";
  import { app } from "../../stores/state.svelte";
  import { fmtAgo } from "../../utils/format";
  import type { NewsItem, NewsVendor } from "../../types/api";

  const VENDOR_LABEL: Record<NewsVendor, string> = {
    anthropic: "Anthropic", openai: "OpenAI", zai: "Z.ai",
    moonshot: "Moonshot", deepseek: "DeepSeek",
  };

  let open = $state(false);
  // Freeze the crawl (and its content — a 60s poll can prepend items) while
  // the pointer is anywhere on the bar, so the link the user is aiming at
  // never moves. Resuming waits a beat: slipping off an item's edge for a
  // moment shouldn't yank the target away mid-aim.
  let paused = $state(false);
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  function pause() { clearTimeout(resumeTimer); paused = true; }
  function unpause() {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => { paused = false; }, 300);
  }
  let items = $state<NewsItem[]>([]);
  $effect(() => {
    const next = app.news?.items ?? [];
    if (!paused) items = next;
  });
  // a sparse list leaves a dead gap in the loop — repeat until a group is
  // comfortably wider than any viewport
  const loop = $derived(
    items.length ? Array.from({ length: Math.max(1, Math.ceil(10 / items.length)) }, () => items).flat() : [],
  );

  // The crawl is a pixel-based rAF loop rather than a CSS keyframe animation:
  // a keyframed translateX(-50%) re-times whenever content changes track
  // width or duration, snapping the whole ticker by an arbitrary distance.
  // Constant px/s is continuous across content swaps and hover pauses.
  const SPEED = 34; // px/s
  let track = $state<HTMLDivElement | undefined>();
  let groupW = $state(0);
  let offset = 0;
  let raf = 0;
  let motionEnabled = false;
  let last = 0;

  function startLoop() {
    if (!motionEnabled || raf || paused || !items.length || !track || groupW <= 0) return;
    last = performance.now();
    raf = requestAnimationFrame(step);
  }

  function step(now: number) {
    raf = 0;
    if (paused || !items.length || !track || groupW <= 0) return;
    const dt = Math.min(0.1, (now - last) / 1000); // clamp tab-switch gaps
    last = now;
    offset = (offset + SPEED * dt) % groupW;
    track.style.transform = `translate3d(${-offset}px,0,0)`;
    raf = requestAnimationFrame(step);
  }

  // Keep the loop-point width current (content swaps, font load, resizes).
  $effect(() => {
    const group = track?.firstElementChild as HTMLElement | undefined;
    if (!group) return;
    const ro = new ResizeObserver(() => { groupW = group.offsetWidth; startLoop(); });
    ro.observe(group);
    return () => ro.disconnect();
  });

  $effect(() => {
    items.length; paused; track; groupW;
    startLoop();
  });

  onMount(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    motionEnabled = true;
    startLoop();
    return () => { cancelAnimationFrame(raf); clearTimeout(resumeTimer); };
  });

  function age(at: number): string {
    const s = Math.max(0, (Date.now() - at) / 1000);
    if (s < 3600) return `${Math.max(1, Math.floor(s / 60))}m`;
    if (s < 86400) return `${Math.floor(s / 3600)}h`;
    return `${Math.floor(s / 86400)}d`;
  }
</script>

{#if items.length}
  <!-- svelte-ignore a11y_no_static_element_interactions -- hover-pause only, not interactive -->
  <div class="tk glass" onpointerenter={pause} onpointerleave={unpause}>
    <button class="tk-cap" title="News history"
      onclick={e => { e.stopPropagation(); open = !open; }}>
      <span class="live-dot"></span> Wire <span class="tk-chev" class:up={open}>▾</span>
    </button>
    <div class="tk-view">
      <div class="tk-track" bind:this={track}>
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

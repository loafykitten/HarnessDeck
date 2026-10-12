<script lang="ts">
  import type { Snippet } from "svelte";
  import UsageRing from "./UsageRing.svelte";

  // A harness card's 5-hour window cell; the caption under the title is the
  // harness's own (reset time, staleness, snapshot age).
  let { idp, pct, title, children }: { idp: string; pct: number | null; title: string; children: Snippet } = $props();
</script>

<div class="hc-cell ring-card">
  <UsageRing {idp} {pct}/>
  <div class="ring-info">
    <h3>{title}</h3>
    <div class="big">Current window</div>
    <div class="meta">{@render children()}</div>
  </div>
</div>

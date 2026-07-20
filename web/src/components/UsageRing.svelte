<script lang="ts">
  // The 5-hour ring, verbatim from the dashboard's original ring card.
  // idp prefixes the SVG def ids so two rings can live on one page.
  const { pct, idp }: { pct: number | null; idp: string } = $props();

  const RING_C = 333; // 2πr for r=53

  // SMIL animations ignore the reduced-motion media query, so gate them here.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
</script>

<div class="ring">
  <svg width="126" height="126" viewBox="0 0 126 126">
    <defs>
      <linearGradient id="{idp}-rg" x1="0" y1="0" x2="1" y2="1">
        {#if !reduceMotion}
          <animate attributeName="x1" values="0;1;1;0;0" dur="3s" repeatCount="indefinite"/>
          <animate attributeName="y1" values="0;0;1;1;0" dur="3s" repeatCount="indefinite"/>
          <animate attributeName="x2" values="1;0;0;1;1" dur="3s" repeatCount="indefinite"/>
          <animate attributeName="y2" values="1;1;0;0;1" dur="3s" repeatCount="indefinite"/>
        {/if}
        <stop offset="0" stop-color="var(--accent)"/>
        <stop offset="0.5" stop-color="var(--accent-3)"/>
        <stop offset="1" stop-color="var(--accent-2)"/>
      </linearGradient>
      <filter id="{idp}-arcglow" x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="4">
          {#if !reduceMotion}
            <animate attributeName="stdDeviation" values="3;8;3" dur="2s" repeatCount="indefinite"/>
          {/if}
        </feGaussianBlur>
      </filter>
    </defs>
    <circle cx="63" cy="63" r="53" fill="none" stroke="var(--ring-track)" stroke-width="13"/>
    <circle class="arc-glow" cx="63" cy="63" r="53" fill="none" stroke="url(#{idp}-rg)" stroke-width="16" stroke-linecap="round"
      filter="url(#{idp}-arcglow)"
      stroke-dasharray={RING_C}
      stroke-dashoffset={RING_C * (1 - (pct ?? 0) / 100)}/>
    <circle class="arc" cx="63" cy="63" r="53" fill="none" stroke="url(#{idp}-rg)" stroke-width="13" stroke-linecap="round"
      stroke-dasharray={RING_C}
      stroke-dashoffset={RING_C * (1 - (pct ?? 0) / 100)}/>
  </svg>
  <div class="val"><b>{pct ?? "–"}%</b><small>USED</small></div>
</div>

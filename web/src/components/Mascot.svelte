<script lang="ts">
  import { onSlopmaxx } from "../lib/mascot";

  const PHRASES = [
    "Discombobulating…", "Reticulating…", "Pondering…", "Noodling…",
    "Percolating…", "Marinating…", "Simmering…", "Ruminating…",
    "Cogitating…", "Clauding…", "Vibing…", "Wibbling…",
    "Moseying…", "Puttering…", "Schlepping…", "Honking…",
    "Frolicking…", "Booping…", "Transmuting…", "Manifesting…",
    "Flibbertigibbeting…", "Slopmaxxing…",
  ];

  let phrase = $state("");
  let visible = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  // Single entry point for all bubbles: only the hide timer is ever reset,
  // so the phrase-change interval below keeps its cadence no matter what.
  function show(text: string) {
    phrase = text;
    visible = true;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => (visible = false), 4500);
  }

  function randomPhrase() {
    let next = phrase;
    while (next === phrase) next = PHRASES[Math.floor(Math.random() * PHRASES.length)];
    show(next);
  }

  $effect(() => {
    const first = setTimeout(randomPhrase, 2500);
    const interval = setInterval(randomPhrase, 14000);
    const off = onSlopmaxx(() => show("Slopmaxxing…"));
    return () => { clearTimeout(first); clearInterval(interval); clearTimeout(hideTimer); off(); };
  });
</script>

<div class="mascot-track" aria-hidden="true">
  <div class="mascot-roller">
    {#if visible}<div class="mascot-bubble">{phrase}</div>{/if}
    <!-- ophanim: wheel-within-wheel, many-eyed (see Rail.svelte) -->
    <svg class="mascot-wheel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
      <circle cx="12" cy="12" r="8.6"/>
      <ellipse cx="12" cy="12" rx="8.6" ry="3.4"/>
      <ellipse cx="12" cy="12" rx="3.4" ry="8.6"/>
      <circle cx="12" cy="12" r="2.1"/>
      <circle cx="12" cy="12" r="0.7" fill="currentColor" stroke="none"/>
      <circle cx="18.1" cy="5.9" r="0.7" fill="currentColor" stroke="none"/>
      <circle cx="18.1" cy="18.1" r="0.7" fill="currentColor" stroke="none"/>
      <circle cx="5.9" cy="5.9" r="0.7" fill="currentColor" stroke="none"/>
      <circle cx="5.9" cy="18.1" r="0.7" fill="currentColor" stroke="none"/>
    </svg>
  </div>
</div>

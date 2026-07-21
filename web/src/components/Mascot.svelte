<script lang="ts">
  import { onSlopmaxx } from "../lib/mascot";
  import { PETS } from "../lib/pets";
  import { app } from "../lib/state.svelte";

  const PHRASES = [
    "Discombobulating…", "Reticulating…", "Pondering…", "Noodling…",
    "Percolating…", "Marinating…", "Simmering…", "Ruminating…",
    "Cogitating…", "Clauding…", "Vibing…", "Wibbling…",
    "Moseying…", "Puttering…", "Schlepping…", "Honking…",
    "Frolicking…", "Booping…", "Transmuting…", "Manifesting…",
    "Flibbertigibbeting…", "Slopmaxxing…", "Cortisolmaxxing…",
  ];

  let phrase = $state("");
  let visible = $state(false);
  let flipped = $state(false);
  let track: HTMLDivElement;
  let roller: HTMLDivElement;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;

  const pet = $derived(PETS[app.pet] ?? PETS.biblical);

  // Idle animations: every so often the pet does one of its tricks (bounce,
  // spin, peering at you, grooming…) picked at random. The class lands on
  // .mascot-hopper so it composes with the roller's travel; glyph pets can
  // also swap their face line for the duration.
  let idleAnim = $state<string | null>(null);
  let idleFace = $state<string | null>(null);

  // Bubble sits to the mascot's right by default; once he's past ~55% of the
  // track it would run off-screen, so anchor it to his left instead.
  function updateSide() {
    if (!track || !roller) return;
    const t = track.getBoundingClientRect();
    const r = roller.getBoundingClientRect();
    flipped = (r.left + r.width / 2 - t.left) > t.width * 0.55;
  }

  // Single entry point for all bubbles: only the hide timer is ever reset,
  // so the phrase-change interval below keeps its cadence no matter what.
  function show(text: string) {
    phrase = text;
    updateSide();
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
    // He keeps rolling while a bubble is up — re-check which side fits.
    const side = setInterval(() => { if (visible) updateSide(); }, 400);
    const off = onSlopmaxx(() => show("Slopmaxxing…"));
    return () => { clearTimeout(first); clearInterval(interval); clearInterval(side); clearTimeout(hideTimer); off(); };
  });

  // Restarts whenever the pet changes (reads `pet` reactively).
  $effect(() => {
    const idles = pet.idles;
    let doTimer: ReturnType<typeof setTimeout>;
    let clearTimer: ReturnType<typeof setTimeout>;
    function schedule() {
      doTimer = setTimeout(() => {
        const pick = idles[Math.floor(Math.random() * idles.length)];
        idleAnim = pick.anim;
        idleFace = pick.face ?? null;
        clearTimer = setTimeout(() => { idleAnim = null; idleFace = null; schedule(); }, pick.ms);
      }, 5000 + Math.random() * 8000);
    }
    schedule();
    return () => { clearTimeout(doTimer); clearTimeout(clearTimer); idleAnim = null; idleFace = null; };
  });
</script>

<div class="mascot-track" aria-hidden="true" bind:this={track}>
  <div class="mascot-roller" bind:this={roller}>
    {#if visible}<div class="mascot-bubble" class:flip={flipped}>{phrase}</div>{/if}
    <div class={"mascot-hopper" + (idleAnim ? ` idle-${idleAnim}` : "")}>
      {#if pet.lines}
        <div class="mascot-glyph" style="--pet-ink:{pet.ink};--pet-glow:{pet.glow}">
          <span>{pet.lines[0]}</span>
          <span>{idleFace ?? pet.lines[1]}</span>
          <span>{pet.lines[2]}</span>
        </div>
      {:else}
        <!-- ophanim: wheel-within-wheel, many-eyed, claude-spark hub (see Rail.svelte) -->
        <svg class="mascot-wheel" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
          <circle cx="12" cy="12" r="8.6"/>
          <ellipse cx="12" cy="12" rx="8.6" ry="3.4"/>
          <ellipse cx="12" cy="12" rx="3.4" ry="8.6"/>
          <path stroke-width="1.1" d="M12 7.4V10.2M12 13.8V16.6M7.4 12H10.2M13.8 12H16.6M8.75 8.75 10.73 10.73M13.27 13.27 15.25 15.25M15.25 8.75 13.27 10.73M8.75 15.25 10.73 13.27"/>
          <circle cx="12" cy="12" r="0.7" fill="currentColor" stroke="none"/>
          <circle cx="18.1" cy="5.9" r="0.7" fill="currentColor" stroke="none"/>
          <circle cx="18.1" cy="18.1" r="0.7" fill="currentColor" stroke="none"/>
          <circle cx="5.9" cy="5.9" r="0.7" fill="currentColor" stroke="none"/>
          <circle cx="5.9" cy="18.1" r="0.7" fill="currentColor" stroke="none"/>
        </svg>
      {/if}
    </div>
  </div>
</div>

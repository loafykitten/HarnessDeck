<script lang="ts">
  // Pasted images attached to a message. A single image shows as one thumb;
  // several stack into a fan that spreads apart on hover.
  let { images }: { images: string[] } = $props();

  let open = $state<string | null>(null);
  let failed = $state(new Set<string>());

  const src = (name: string) => `/api/chat/pastes/${encodeURIComponent(name)}`;

  // Pastes are pruned after 30 days, and history rehydrated from a harness
  // transcript has no basenames — so a thumb can legitimately 404.
  function fail(name: string) {
    failed = new Set(failed).add(name);
    if (open === name) open = null;
  }

  let shown = $derived(images.filter(name => !failed.has(name)));

  function onKeydown(event: KeyboardEvent) {
    if (event.key === "Escape") open = null;
  }
</script>

<svelte:window onkeydown={onKeydown} />

{#if shown.length}
  <div class="msg-images" class:fan={shown.length > 1} style:--n={shown.length}>
    {#each shown as name, i (name)}
      <button class="msg-image" style:--i={i} onclick={() => (open = name)}
        aria-label="View attached image {i + 1} of {shown.length}">
        <img src={src(name)} alt="Attachment {i + 1}" loading="lazy" onerror={() => fail(name)} />
      </button>
    {/each}
  </div>
{:else if images.length}
  <div class="msg-images-gone">{images.length === 1 ? "image" : `${images.length} images`} no longer available</div>
{/if}

{#if open}
  <div class="image-lightbox">
    <button class="lightbox-backdrop" aria-label="Close image" onclick={() => (open = null)}></button>
    <img src={src(open)} alt="Attachment, full size" onerror={() => open && fail(open)} />
  </div>
{/if}

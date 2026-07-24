<script lang="ts">
  import { tailPath, toolLook } from "../../../lib/tools";

  let { name, input, result, isError, running }: {
    name: string; input?: unknown; result?: unknown; isError?: boolean; running: boolean;
  } = $props();

  // Tool identity drives the glyph and accent colour, so a run of actions
  // reads as a scannable log rather than a stack of identical cards.
  const PATH_KEYS = ["file_path", "path", "notebook_path"];
  const ARG_KEYS = ["command", "file_path", "path", "notebook_path", "pattern", "query", "url", "description"];

  let look = $derived(toolLook(name));
  let kind = $derived(look.kind);
  let glyph = $derived(look.glyph);

  let arg = $derived.by(() => {
    if (!input || typeof input !== "object") return "";
    const value = input as Record<string, unknown>;
    for (const key of ARG_KEYS) {
      const found = value[key];
      if (typeof found === "string") return PATH_KEYS.includes(key) ? tailPath(found) : found;
    }
    return JSON.stringify(input);
  });
</script>

<details class="tool-row" class:error={isError} class:running data-kind={kind}>
  <summary>
    <span class="tool-glyph">{glyph}</span>
    <b class="tool-name">{name}</b>
    <span class="tool-arg">{arg}</span>
    {#if running}
      <span class="tool-live" aria-label="running"></span>
    {:else if isError}
      <span class="tool-bad" aria-label="failed">×</span>
    {/if}
  </summary>
  {#if input !== undefined}<pre>{JSON.stringify(input, null, 2)}</pre>{/if}
  {#if result !== undefined}<pre class="tool-result">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>{/if}
</details>

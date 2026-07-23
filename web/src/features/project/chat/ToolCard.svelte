<script lang="ts">
  let { name, input, result, isError, running }: {
    name: string; input?: unknown; result?: unknown; isError?: boolean; running: boolean;
  } = $props();

  function summary(): string {
    if (!input || typeof input !== "object") return "";
    const value = input as Record<string, unknown>;
    for (const key of ["command", "file_path", "path", "pattern", "query", "description"]) {
      if (typeof value[key] === "string") return value[key];
    }
    return JSON.stringify(input);
  }
</script>

<details class="tool-card" class:error={isError}>
  <summary><span class="tool-state">{running ? "◌" : isError ? "×" : "✓"}</span><b>{name}</b><span>{summary()}</span></summary>
  {#if input !== undefined}<pre>{JSON.stringify(input, null, 2)}</pre>{/if}
  {#if result !== undefined}<pre class="tool-result">{typeof result === "string" ? result : JSON.stringify(result, null, 2)}</pre>{/if}
</details>

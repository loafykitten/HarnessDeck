<script lang="ts">
  let { text }: { text: string } = $props();

  type Inline = { kind: "text" | "code" | "bold"; text: string };
  type Block = { kind: "text" | "code"; text: string; language?: string; inline?: Inline[] };

  function inline(text: string): Inline[] {
    const parts: Inline[] = [];
    const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > start) parts.push({ kind: "text", text: text.slice(start, index) });
      const raw = match[0];
      parts.push(raw.startsWith("`")
        ? { kind: "code", text: raw.slice(1, -1) }
        : { kind: "bold", text: raw.slice(2, -2) });
      start = index + raw.length;
    }
    if (start < text.length) parts.push({ kind: "text", text: text.slice(start) });
    return parts;
  }

  function parse(text: string): Block[] {
    const blocks: Block[] = [];
    const pattern = /```([^\n]*)\n([\s\S]*?)```/g;
    let start = 0;
    for (const match of text.matchAll(pattern)) {
      const index = match.index ?? 0;
      if (index > start) {
        const value = text.slice(start, index);
        blocks.push({ kind: "text", text: value, inline: inline(value) });
      }
      blocks.push({ kind: "code", language: match[1].trim(), text: match[2].replace(/\n$/, "") });
      start = index + match[0].length;
    }
    if (start < text.length || blocks.length === 0) {
      const value = text.slice(start);
      blocks.push({ kind: "text", text: value, inline: inline(value) });
    }
    return blocks;
  }

  const blocks = $derived(parse(text));
</script>

<div class="chat-markdown">
  {#each blocks as block, i (`${i}-${block.kind}`)}
    {#if block.kind === "code"}
      <pre><span>{block.language}</span><code>{block.text}</code></pre>
    {:else}
      <span class="md-text">{#each block.inline ?? [] as part, j (j)}{#if part.kind === "code"}<code>{part.text}</code>{:else if part.kind === "bold"}<strong>{part.text}</strong>{:else}{part.text}{/if}{/each}</span>
    {/if}
  {/each}
</div>

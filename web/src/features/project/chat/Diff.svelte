<script lang="ts">
  import type { DiffLine } from "../../../lib/diff";

  let { lines, label, note }: { lines: DiffLine[]; label?: string; note?: string } = $props();

  const MARK: Record<DiffLine["kind"], string> = { add: "+", del: "−", ctx: " ", meta: "" };
  /** DOM guard: past this, extra rows only add scroll distance and jank. */
  const MAX_ROWS = 400;

  let added = $derived(lines.filter(line => line.kind === "add").length);
  let removed = $derived(lines.filter(line => line.kind === "del").length);
  let shown = $derived(lines.length > MAX_ROWS ? lines.slice(0, MAX_ROWS) : lines);
  let omitted = $derived(lines.length - shown.length);
</script>

<div class="diff-block">
  {#if label}
    <div class="diff-head">
      <span class="diff-path">{label}</span>
      {#if note}<span class="diff-note">{note}</span>{/if}
      {#if added}<span class="diff-stat add">+{added}</span>{/if}
      {#if removed}<span class="diff-stat del">−{removed}</span>{/if}
    </div>
  {/if}
  <div class="diff-body">
    {#each shown as line, i (i)}
      <div class="diff-line {line.kind}"><span class="diff-mark">{MARK[line.kind]}</span><span class="diff-text">{line.text}</span></div>
    {/each}
    {#if omitted > 0}<div class="diff-omitted">… {omitted} more {omitted === 1 ? "line" : "lines"} not shown</div>{/if}
  </div>
</div>

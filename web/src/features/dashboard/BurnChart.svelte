<script lang="ts">
  // Daily token-burn columns + axis, verbatim from the dashboard's month card.
  // Renders nothing until there are at least two days to compare.
  import { fmtTokens, fmtUSD } from "../../utils/format";

  const { days }: { days: { date: string; tokens: number; costUSD: number }[] } = $props();

  const max = $derived(Math.max(...days.map(d => d.tokens), 1));
  let tip = $state<number | null>(null);
  function fmtDay(iso: string): string {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }
</script>

{#if days.length > 1}
  <div class="burn" role="img"
    aria-label="Daily token burn; peak {fmtTokens(max)} on {fmtDay(days.reduce((a, b) => b.tokens > a.tokens ? b : a).date)}">
    {#each days as d, i (d.date)}
      <div class="burn-band" role="presentation"
        onpointerenter={() => tip = i} onpointerleave={() => tip = null}>
        {#if d.tokens > 0}
          <i class:today={i === days.length - 1} class:hot={i === tip}
            style="height:{d.tokens / max * 100}%"></i>
        {/if}
      </div>
    {/each}
    {#if tip !== null && days[tip]}
      <div class="burn-tip" style="left:clamp(46px, {(tip + 0.5) / days.length * 100}%, calc(100% - 46px))">
        <b>{fmtTokens(days[tip].tokens)} tokens</b>
        <span>{fmtDay(days[tip].date)} · {fmtUSD(days[tip].costUSD)}</span>
      </div>
    {/if}
  </div>
  <div class="burn-axis">
    <span>{fmtDay(days[0].date)}</span>
    <span>peak {fmtTokens(max)}/day</span>
    <span>today</span>
  </div>
{/if}

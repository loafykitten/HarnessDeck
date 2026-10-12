<script lang="ts">
  import { fmtClock } from "../../utils/format";
  import { clampPct } from "./format";

  // A harness card's weekly quota cell, with an optional per-model sub-bar
  // (Claude's weekly cap on its top model).
  let { label, pct, resetsAt, weeklyModel = null }: {
    label: string;
    pct: number | null;
    resetsAt: string | null;
    weeklyModel?: { model: string; pct: number } | null;
  } = $props();
  const modelPct = $derived(clampPct(weeklyModel?.pct));
</script>

<div class="hc-cell">
  <h3>Weekly quota</h3>
  <div class="card-sub">Rolling 7-day allowance</div>
  <div class="bar-wrap">
    <div class="bar-num">{pct ?? "–"}<span>%</span></div>
    <div class="bar-label"><span>{label}</span><b>{pct ?? "–"}%</b></div>
    <div class="bar-frame"><div class="bar"><span class="bar-glow" style="width:{pct ?? 0}%"></span><i style="width:{pct ?? 0}%"></i></div></div>
    {#if weeklyModel}
      <div class="bar-label"><span>{weeklyModel.model}</span><b>{weeklyModel.pct}%</b></div>
      <div class="bar-frame"><div class="bar sub"><span class="bar-glow alt" style="width:{modelPct ?? 0}%"></span><i class="alt" style="width:{modelPct ?? 0}%"></i></div></div>
    {/if}
    <div class="reset">Resets <b>{fmtClock(resetsAt)}</b></div>
  </div>
</div>

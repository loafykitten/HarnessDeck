<script lang="ts">
  import { app } from "../../stores/state.svelte";
  import { fmtClock, fmtDate, fmtTokens, fmtUSD } from "../../utils/format";
  import { clampPct, remaining } from "./format";
  import UsageRing from "./UsageRing.svelte";
  import BurnChart from "./BurnChart.svelte";
  import UpdateChip from "./UpdateChip.svelte";
  import PlanBadge from "./PlanBadge.svelte";

  const fivePct = $derived(clampPct(app.usage?.limits?.fiveHour?.pct));
  const weekPct = $derived(clampPct(app.usage?.limits?.weekly?.pct));
  const modelPct = $derived(clampPct(app.usage?.limits?.weeklyModel?.pct));
</script>

<div class="glass glow card harness-card">
  <div class="hc-head">
    <h3 class="hc-claude">Claude</h3>
    <div class="hc-right">
      <UpdateChip harness="claude" label="Claude Code" />
      {#if app.usage?.limits?.plan}
        <PlanBadge plan={app.usage.limits.plan} />
      {/if}
    </div>
  </div>
  <div class="hc-body">
    <div class="hc-cell ring-card">
      <UsageRing idp="cl" pct={fivePct}/>
      <div class="ring-info">
        <h3>5-hour block</h3>
        <div class="big">Current window</div>
        <div class="meta">
          Resets <em>{fmtClock(app.usage?.limits?.fiveHour?.resetsAt ?? null)}</em><br>
          {remaining(app.usage?.limits?.fiveHour?.resetsAt ?? null)}
        </div>
      </div>
    </div>

    <div class="hc-cell">
      <h3>Weekly quota</h3>
      <div class="card-sub">Rolling 7-day allowance</div>
      <div class="bar-wrap">
        <div class="bar-num">{weekPct ?? "–"}<span>%</span></div>
        <div class="bar-label"><span>all models</span><b>{weekPct ?? "–"}%</b></div>
        <div class="bar-frame"><div class="bar"><span class="bar-glow" style="width:{weekPct ?? 0}%"></span><i style="width:{weekPct ?? 0}%"></i></div></div>
        {#if app.usage?.limits?.weeklyModel}
          <div class="bar-label"><span>{app.usage.limits.weeklyModel.model}</span><b>{app.usage.limits.weeklyModel.pct}%</b></div>
          <div class="bar-frame"><div class="bar sub"><span class="bar-glow alt" style="width:{modelPct ?? 0}%"></span><i class="alt" style="width:{modelPct ?? 0}%"></i></div></div>
        {/if}
        <div class="reset">Resets <b>{fmtClock(app.usage?.limits?.weekly?.resetsAt ?? null)}</b></div>
      </div>
    </div>

    <div class="hc-cell">
      <h3>{app.usage?.month?.since ? "This billing cycle" : "This month"}</h3>
      <div class="stat-big">{app.usage?.month ? fmtTokens(app.usage.month.totalTokens) : "–"}</div>
      <div class="stat-sub">
        tokens · <b>{app.usage?.month ? fmtUSD(app.usage.month.costUSD) : "–"}</b> API-equivalent
        {#if app.usage?.month?.since}<br>since {fmtDate(app.usage.month.since)}{/if}
      </div>
      <BurnChart days={app.usage?.month?.days ?? []}/>
    </div>
  </div>
</div>

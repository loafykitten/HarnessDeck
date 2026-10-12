<script lang="ts">
  import { app } from "../../stores/state.svelte";
  import { fmtAgo, fmtClock, fmtDate, fmtTokens, fmtUSD } from "../../utils/format";
  import { clampPct, remaining } from "./format";
  import RingCell from "./RingCell.svelte";
  import QuotaCell from "./QuotaCell.svelte";
  import BurnChart from "./BurnChart.svelte";
  import UpdateChip from "./UpdateChip.svelte";
  import PlanBadge from "./PlanBadge.svelte";

  const fivePct = $derived(clampPct(app.usage?.limits?.fiveHour?.pct));
  const weekPct = $derived(clampPct(app.usage?.limits?.weekly?.pct));

  const fiveResets = $derived(app.usage?.limits?.fiveHour?.resetsAt ?? null);
  // Dead sign-in won't self-heal — distinct from ordinary staleness.
  const authExpired = $derived(!!app.usage?.limits?.authExpired);
  // Stale when the server flags cached data, or when the window it describes
  // already elapsed — either way the live-looking "~0m remaining" would lie.
  const stale = $derived(
    !!app.usage?.limits?.stale ||
    (fiveResets != null && new Date(fiveResets).getTime() < Date.now()));
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
    <RingCell idp="cl" pct={fivePct} title="5-hour block">
      {#if authExpired}
        <span class="stale">sign-in expired — run <code>claude</code> to reauthenticate</span>
      {:else if stale}
        <span class="stale">{app.usage?.limits?.fetchedAt
          ? `data from ${fmtAgo(new Date(app.usage.limits.fetchedAt).getTime())} — reconnecting`
          : "reconnecting…"}</span>
      {:else}
        Resets <em>{fmtClock(fiveResets)}</em><br>
        {remaining(fiveResets)}
      {/if}
    </RingCell>

    <QuotaCell label="all models" pct={weekPct} resetsAt={app.usage?.limits?.weekly?.resetsAt ?? null}
      weeklyModel={app.usage?.limits?.weeklyModel} />

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

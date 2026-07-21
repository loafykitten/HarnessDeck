<script lang="ts">
  import { app, refreshUsage } from "../../stores/state.svelte";
  import { api } from "../../lib/api";
  import { fmtAgo, fmtClock, fmtTokens, fmtUSD } from "../../utils/format";
  import type { CodexMode } from "../../types/api";
  import { clampPct, remaining } from "./format";
  import UsageRing from "./UsageRing.svelte";
  import BurnChart from "./BurnChart.svelte";
  import UpdateChip from "./UpdateChip.svelte";
  import PlanBadge from "./PlanBadge.svelte";

  const cx = $derived(app.usage?.codex ?? null);
  const cxFive = $derived(clampPct(cx?.limits?.fiveHour?.pct));
  const cxWeek = $derived(clampPct(cx?.limits?.weekly?.pct));
  const cxSpend = $derived(cx?.spend ?? null);
  let cxBusy = $state(false);
  let cxErr = $state("");
  async function setCodexMode(mode: CodexMode) {
    if (cxBusy || !cx || cx.mode === mode) return;
    cxBusy = true;
    cxErr = "";
    try {
      const res = await api.setCodexMode(mode);
      if (app.usage?.codex) app.usage.codex.mode = res.mode;
      await refreshUsage();
    } catch (e) {
      cxErr = e instanceof Error ? e.message : "toggle failed";
    } finally {
      cxBusy = false;
    }
  }
</script>

{#if cx}
  <div class="glass glow card harness-card">
    <div class="hc-head">
      <h3 class="hc-codex">Codex</h3>
      <div class="je-modes" class:cx-busy={cxBusy}>
        <button class="je-mode" class:on={cx.mode === "oauth"} disabled={cxBusy}
          title="Comment out model_provider in ~/.codex/config.toml — Codex uses your ChatGPT login"
          onclick={() => setCodexMode("oauth")}>ChatGPT OAuth</button>
        <button class="je-mode" class:on={cx.mode === "api"} disabled={cxBusy}
          title="Re-enable model_provider in ~/.codex/config.toml — Codex bills your API key"
          onclick={() => setCodexMode("api")}>API key</button>
      </div>
      <span class="cx-note">
        {#if cxErr}<span class="cx-err">{cxErr}</span>
        {:else if cx.mode === "oauth"}signed in with ChatGPT — usage draws on your subscription's windows
        {:else}pay-as-you-go on your {cx.providerName ?? "API"} key{/if}
      </span>
      <div class="hc-right">
        <UpdateChip harness="codex" label="Codex" />
        {#if cx.plan}
          <PlanBadge plan={cx.plan} />
        {/if}
      </div>
    </div>
    <div class="hc-body">
      {#if cx.mode === "oauth"}
        <div class="hc-cell ring-card">
          <UsageRing idp="cx" pct={cxFive}/>
          <div class="ring-info">
            <h3>5-hour window</h3>
            <div class="big">Current window</div>
            <div class="meta">
              Resets <em>{fmtClock(cx.limits?.fiveHour?.resetsAt ?? null)}</em><br>
              {remaining(cx.limits?.fiveHour?.resetsAt ?? null)}
              {#if cx.limits?.asOf}<br>snapshot {fmtAgo(new Date(cx.limits.asOf).getTime())}{/if}
            </div>
          </div>
        </div>

        <div class="hc-cell">
          <h3>Weekly quota</h3>
          <div class="card-sub">Rolling 7-day allowance</div>
          <div class="bar-wrap">
            <div class="bar-num">{cxWeek ?? "–"}<span>%</span></div>
            <div class="bar-label"><span>all usage</span><b>{cxWeek ?? "–"}%</b></div>
            <div class="bar-frame"><div class="bar"><span class="bar-glow" style="width:{cxWeek ?? 0}%"></span><i style="width:{cxWeek ?? 0}%"></i></div></div>
            <div class="reset">Resets <b>{fmtClock(cx.limits?.weekly?.resetsAt ?? null)}</b></div>
          </div>
        </div>

        <div class="hc-cell">
          <h3>This month</h3>
          <div class="stat-big">{cxSpend ? fmtTokens(cxSpend.oauth.tokens) : "–"}</div>
          <div class="stat-sub">
            subscription tokens · <b>{cxSpend ? fmtUSD(cxSpend.oauth.costUSD) : "–"}</b> API-equivalent
            {#if cxSpend && cxSpend.api.tokens > 0}<br>plus {fmtTokens(cxSpend.api.tokens)} tokens · {fmtUSD(cxSpend.api.costUSD)} on your API key{/if}
          </div>
          <!-- the daily series has no per-auth split, so the chart is all
               Codex usage — caption it so it can't be read as subscription-only -->
          <div class="card-sub">daily burn · all Codex usage</div>
          <BurnChart days={cx.month?.days ?? []}/>
        </div>
      {:else}
        <div class="hc-cell">
          <h3>API spend</h3>
          <div class="stat-big">{cxSpend ? fmtUSD(cxSpend.api.costUSD) : "–"}</div>
          <div class="stat-sub">this month on your {cx.providerName ?? "API"} key</div>
        </div>

        <div class="hc-cell">
          <h3>API-key tokens</h3>
          <div class="stat-big">{cxSpend ? fmtTokens(cxSpend.api.tokens) : "–"}</div>
          <div class="stat-sub">
            pay-as-you-go this month
            {#if cxSpend && cxSpend.oauth.tokens > 0}<br>plus {fmtTokens(cxSpend.oauth.tokens)} subscription tokens · {fmtUSD(cxSpend.oauth.costUSD)} API-equivalent{/if}
          </div>
        </div>

        <div class="hc-cell">
          <h3>Daily burn</h3>
          <div class="card-sub">All Codex usage this month</div>
          <BurnChart days={cx.month?.days ?? []}/>
        </div>
      {/if}
    </div>
  </div>
{/if}

<style>
  .cx-note{font-size:11px;color:var(--ink-faint);flex:1 1 120px;min-width:0;text-align:right;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cx-err{color:var(--accent-2)}
  .cx-busy{opacity:.55;pointer-events:none}
</style>

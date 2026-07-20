<script lang="ts">
  import { app, applyUpdate, navigate, refreshUpdate, refreshUsage } from "../lib/state.svelte";
  import { api, fmtAgo, fmtClock, fmtDate, fmtTokens, fmtUSD, initials, projectGradient, type CodexMode, type HarnessId } from "../lib/api";
  import UsageRing from "./UsageRing.svelte";
  import BurnChart from "./BurnChart.svelte";

  const clampPct = (p: number | null | undefined) =>
    p == null ? null : Math.max(0, Math.min(100, p));
  const fivePct = $derived(clampPct(app.usage?.limits?.fiveHour?.pct));
  const weekPct = $derived(clampPct(app.usage?.limits?.weekly?.pct));
  const modelPct = $derived(clampPct(app.usage?.limits?.weeklyModel?.pct));
  const liveCount = $derived(app.sessions.length);

  // Stable render order: the server sorts sessions by activity, which reshuffles
  // every 5s poll — that moves the keyed rows in the DOM and restarts their CSS
  // animations (status pulse). Sort by creation time (id tie-breaks) so a row
  // keeps its slot across refreshes; recency still shows via "active … ago".
  const sessions = $derived(
    [...app.sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
  );

  // ---- per-harness self-updater chips ----
  // A finished run stays on screen briefly so the outcome is seen, then the
  // chip falls back to the plain version line. Both outcomes are age-gated:
  // the server keeps the last job forever, so an ungated failure would pin the
  // chip to "Update failed" for the life of the process. (refreshUpdate
  // schedules a re-fetch at the end of the window — Date.now() isn't reactive.)
  function updView(h: HarnessId, label: string) {
    const u = app.updates?.[h] ?? null;
    const job = u?.job ?? null;
    const updating = job?.status === "running";
    const jobFresh = !!job?.finishedAt && app.jobDisplayUntil[h] !== null;
    const justUpdated = job?.status === "done" && jobFresh;
    const failed = job?.status === "error" && jobFresh;
    return {
      updating, failed, justUpdated,
      ready: !!u?.updateAvailable,
      canUpdate: !!u?.updateAvailable && !updating,
      text: updating ? `Updating to ${u?.latest ?? "the latest version"}…`
        : failed ? "Update failed"
        : justUpdated ? (u?.installed ? `Updated to ${u.installed}` : "Update complete")
        : u?.updateAvailable ? `${label} ${u.latest} available`
        : u?.installed ? `${label} ${u.installed}`
        : app.updateChecking ? "Checking…"
        : "Version unknown",
      title: updating ? `Running ${h} update — running sessions keep their current version until they restart.`
        : failed ? `${h} update failed:\n${job?.output ?? ""}`
        : u?.error ? u.error
        : u?.updateAvailable ? `You're on ${u.installed}. Click Update to install ${u.latest}.`
        : u ? `Up to date · checked ${fmtAgo(u.checkedAt)}`
        : `Checking for a newer ${label}`,
    };
  }

  function remaining(iso: string | null): string {
    if (!iso) return "";
    const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `~${h}h ${m}m remaining` : `~${m}m remaining`;
  }

  // ---- Codex usage + auth-mode toggle ----
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

<div class="greet-row">
  <div class="greet">
    <h1>
      {app.greeting?.salutation ?? "Welcome back"}
      <svg class="gear" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
        role="button" tabindex="0" aria-label="Personalize greeting"
        onclick={() => navigate({ view: "config" })}
        onkeydown={(e) => e.key === "Enter" && navigate({ view: "config" })}>
        <title>Personalize greeting</title>
        <circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" stroke-linecap="round"/>
      </svg>
    </h1>
    {#if app.greeting?.weather}
      <div class="weather"><span class="wx">{app.greeting.weather}</span></div>
    {/if}
    {#if app.greeting?.whimsy}
      <div class="whim">{app.greeting.whimsy}</div>
    {/if}
  </div>
  <div class="head-side">
    <span class="pill live"><span class="live-dot"></span> {liveCount} session{liveCount === 1 ? "" : "s"} live</span>
  </div>
</div>

{#snippet updChip(h: HarnessId, label: string)}
  {@const v = updView(h, label)}
  <div class="pill upd" class:ready={v.ready} class:busy={v.updating}
    class:failed={v.failed} class:fresh={v.justUpdated} title={v.title}>
    <span class="upd-dot"></span>
    <span class="upd-text">{v.text}</span>
    {#if v.canUpdate}
      <button class="upd-go" onclick={() => applyUpdate(h)}>Update</button>
    {/if}
    <button class="upd-check" onclick={() => refreshUpdate(true)} disabled={app.updateChecking || v.updating}
      aria-label="Check for updates now">
      <svg class:spin={app.updateChecking || v.updating} viewBox="0 0 24 24" fill="none"
        stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
        <path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 4v7h-7"/>
      </svg>
    </button>
  </div>
{/snippet}

{#snippet planBadge(plan: { label: string; renewsAt: string | null })}
  <span class="hc-plan">
    <span class="plan-badge"><span class="spk"></span><b>{plan.label}</b></span>
    {#if plan.renewsAt}<span class="plan-renew">renews {fmtDate(plan.renewsAt)}</span>{/if}
  </span>
{/snippet}

<div class="glass glow card harness-card">
  <div class="hc-head">
    <h3 class="hc-claude">Claude</h3>
    <div class="hc-right">
      {@render updChip("claude", "Claude Code")}
      {#if app.usage?.limits?.plan}
        {@render planBadge(app.usage.limits.plan)}
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
        {@render updChip("codex", "Codex")}
        {#if cx.plan}
          {@render planBadge(cx.plan)}
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

<div class="grid lower-grid">
  <div class="glass glow sessions">
    <h3>Active sessions</h3>
    <div class="card-sub">One click to jump in</div>
    <div class="sess-list">
      {#each sessions as s, i (s.id)}
        <button class="sess-item" onclick={() => navigate({ view: "project", name: s.project, session: s.id })}>
          <div class="sess-ico" class:alt={i % 2 === 1}>{i % 2 === 0 ? "◈" : "⬡"}</div>
          <div class="sess-meta"><b>{s.project}</b><div class="s">active {fmtAgo(s.activity)} · {s.harness}</div></div>
          <span class="sess-status {s.status}"><i></i>{s.status === "waiting" ? "needs you" : s.status}</span>
          <span class="sess-tag">{s.name}</span>
          <span class="sess-go">›</span>
        </button>
      {:else}
        <div class="sess-empty">No sessions running — open a project below to start one.</div>
      {/each}
    </div>
  </div>

  <div class="proj-section">
    <h3>Projects</h3>
    <div class="card-sub">{app.projects.length} tracked repositories</div>
    <div class="proj-grid">
      {#each app.projects as p (p.name)}
        <button class="pcard" onclick={() => navigate({ view: "project", name: p.name })}>
          <div class="ptop"><span class="pav" style="background:{projectGradient(p.name)}">{initials(p.name)}</span><b>{p.name}</b></div>
          {#if p.sessions.length > 0}
            <div class="pstatus stat-run"><span class="mini-dot on"></span>{p.sessions.length} session{p.sessions.length === 1 ? "" : "s"} running · active {fmtAgo(p.lastActivity)}</div>
          {:else}
            <div class="pstatus"><span class="mini-dot off"></span>idle · {fmtAgo(p.lastActivity)}</div>
          {/if}
        </button>
      {/each}
    </div>
  </div>
</div>

<style>
  /* Harness rows — one wide card per harness, its widgets side by side.
     The widgets themselves (ring, bars, stat + burn) are the global app.css
     ones, unchanged; only this row shell is new. */
  .harness-card{margin-bottom:16px}
  .hc-head{display:flex;align-items:center;gap:14px;flex-wrap:wrap;row-gap:8px}
  .hc-head h3{margin:0}
  .hc-claude{color:var(--accent)}
  .hc-codex{color:var(--accent-3)}
  .hc-right{margin-left:auto;display:flex;align-items:center;gap:14px}
  /* plan-badge is 16px for the old plan card; header scale is smaller */
  .hc-plan{display:inline-flex;align-items:baseline;gap:8px}
  .hc-plan :global(.plan-badge){font-size:14px}
  .cx-note{font-size:11px;color:var(--ink-faint);flex:1 1 120px;min-width:0;text-align:right;
    overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .cx-err{color:var(--accent-2)}
  .cx-busy{opacity:.55;pointer-events:none}
  .hc-body{display:grid;grid-template-columns:1.3fr 1fr 1fr;margin-top:16px}
  .hc-cell{min-width:0;padding:0 26px}
  .hc-cell:first-child{padding-left:0}
  .hc-cell:last-child{padding-right:0}
  .hc-cell + .hc-cell{border-left:1px solid var(--glass-brd)}
  @media (max-width:980px){
    .hc-body{grid-template-columns:1fr}
    .hc-cell{padding:20px 0}
    .hc-cell:first-child{padding-top:0}
    .hc-cell:last-child{padding-bottom:0}
    .hc-cell + .hc-cell{border-left:0;border-top:1px solid var(--glass-brd)}
  }

  /* Claude Code updater chip — quiet at rest, lit when an update is waiting */
  .upd{gap:9px;padding-right:6px;color:var(--ink-dim)}
  .upd-dot{width:7px;height:7px;border-radius:50%;background:var(--ink-faint);flex-shrink:0}
  .upd-text{white-space:nowrap}
  .upd.ready{border-color:var(--glass-brd-lit);color:var(--ink);
    box-shadow:0 0 22px -8px rgba(var(--accent-rgb),.75)}
  .upd.ready .upd-dot{background:var(--accent);box-shadow:0 0 10px var(--accent);animation:pulse 2s infinite}
  .upd.busy .upd-dot,.upd.fresh .upd-dot{background:var(--ok);box-shadow:0 0 10px var(--ok)}
  .upd.busy .upd-dot{animation:pulse 1.1s infinite}
  .upd.failed .upd-dot{background:var(--accent-2);box-shadow:0 0 10px var(--accent-2)}

  .upd-go{font:inherit;font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;
    padding:4px 11px;border-radius:999px;border:1px solid transparent;color:#fff;
    background:linear-gradient(135deg,var(--accent),var(--accent-3));
    box-shadow:0 0 16px -6px rgba(var(--accent-rgb),.9)}
  .upd-go:hover{filter:brightness(1.12)}

  .upd-check{display:grid;place-items:center;width:24px;height:24px;padding:0;cursor:pointer;
    border:0;border-radius:50%;background:transparent;color:var(--ink-faint)}
  .upd-check svg{width:14px;height:14px}
  .upd-check:hover:not(:disabled){color:var(--ink);background:var(--glass-2)}
  .upd-check:disabled{cursor:default}
  .upd-check svg.spin{animation:updspin 1s linear infinite}
  @keyframes updspin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){
    .upd-check svg.spin,.upd.ready .upd-dot,.upd.busy .upd-dot{animation:none}
  }

  /* session status chip — colors ride the theme tokens, so all skins
     (default/crimson/aero) restyle it for free */
  .sess-status{display:inline-flex;align-items:center;gap:6px;font-size:10px;letter-spacing:.08em;
    text-transform:uppercase;color:var(--ink-faint);padding:3px 9px;border-radius:999px;
    background:var(--glass);border:1px solid var(--glass-brd);white-space:nowrap;flex-shrink:0}
  .sess-status i{width:6px;height:6px;border-radius:50%;background:var(--ink-faint)}
  .sess-status.working{color:var(--ok)}
  .sess-status.working i{background:var(--ok);box-shadow:0 0 8px var(--ok);animation:statuspulse 2s infinite}
  .sess-status.waiting{color:var(--accent)}
  .sess-status.waiting i{background:var(--accent);box-shadow:0 0 8px var(--accent);animation:statuspulse 1.1s infinite}
  @keyframes statuspulse{0%,100%{opacity:1}50%{opacity:.45}}
  @media (prefers-reduced-motion:reduce){.sess-status i{animation:none}}
</style>

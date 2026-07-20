<script lang="ts">
  import { app, applyUpdate, navigate, refreshUpdate, refreshUsage } from "../lib/state.svelte";
  import { api, fmtAgo, fmtClock, fmtDate, fmtTokens, fmtUSD, initials, projectGradient, type CodexMode } from "../lib/api";

  const RING_C = 333; // 2πr for r=53

  // SMIL animations ignore the reduced-motion media query, so gate them here.
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

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

  // daily token burn across the billing window
  const burnDays = $derived(app.usage?.month?.days ?? []);
  const burnMax = $derived(Math.max(...burnDays.map(d => d.tokens), 1));
  let burnTip = $state<number | null>(null);
  function fmtDay(iso: string): string {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  // ---- Claude Code updater ----
  const upd = $derived(app.update);
  const job = $derived(app.update?.job ?? null);
  const updating = $derived(job?.status === "running");
  // A finished run stays on screen briefly so the outcome is seen, then the
  // widget falls back to the plain version line. Both outcomes are age-gated:
  // the server keeps the last job forever, so an ungated failure would pin the
  // chip to "Update failed" for the life of the process. (refreshUpdate
  // schedules a re-fetch at the end of the window — Date.now() isn't reactive.)
  const jobFresh = $derived(!!job?.finishedAt && app.jobDisplayUntil !== null);
  const justUpdated = $derived(job?.status === "done" && jobFresh);
  const updateFailed = $derived(job?.status === "error" && jobFresh);
  const canUpdate = $derived(!!upd?.updateAvailable && !updating);

  const updText = $derived(
    updating ? `Updating to ${upd?.latest ?? "the latest version"}…`
      : updateFailed ? "Update failed"
      : justUpdated ? (upd?.installed ? `Updated to ${upd.installed}` : "Update complete")
      : upd?.updateAvailable ? `Claude Code ${upd.latest} available`
      : upd?.installed ? `Claude Code ${upd.installed}`
      : app.updateChecking ? "Checking…"
      : "Version unknown",
  );

  const updTitle = $derived(
    updating ? "Running claude update — running sessions keep their current version until they restart."
      : updateFailed ? `claude update failed:\n${job?.output ?? ""}`
      : upd?.error ? upd.error
      : upd?.updateAvailable ? `You're on ${upd.installed}. Click Update to install ${upd.latest}.`
      : upd ? `Up to date · checked ${fmtAgo(upd.checkedAt)}`
      : "Checking for a newer Claude Code",
  );

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

    <div class="pill upd" class:ready={upd?.updateAvailable} class:busy={updating}
      class:failed={updateFailed} class:fresh={justUpdated} title={updTitle}>
      <span class="upd-dot"></span>
      <span class="upd-text">{updText}</span>
      {#if canUpdate}
        <button class="upd-go" onclick={applyUpdate}>Update</button>
      {/if}
      <button class="upd-check" onclick={() => refreshUpdate(true)} disabled={app.updateChecking || updating}
        aria-label="Check for updates now">
        <svg class:spin={app.updateChecking || updating} viewBox="0 0 24 24" fill="none"
          stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
          <path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 4v7h-7"/>
        </svg>
      </button>
    </div>
    <div class="plan-card glass lit">
      <span class="pk">Plan</span>
      <span class="plan-badge"><span class="spk"></span><b>{app.usage?.limits?.plan?.label ?? "Claude"}</b></span>
      {#if app.usage?.limits?.plan?.renewsAt}
        <span class="plan-renew">renews {fmtDate(app.usage.limits.plan.renewsAt)}</span>
      {/if}
    </div>
  </div>
</div>

<div class="grid usage-grid">
  <div class="glass glow card ring-card">
    <div class="ring">
      <svg width="126" height="126" viewBox="0 0 126 126">
        <defs>
          <linearGradient id="rg" x1="0" y1="0" x2="1" y2="1">
            {#if !reduceMotion}
              <animate attributeName="x1" values="0;1;1;0;0" dur="3s" repeatCount="indefinite"/>
              <animate attributeName="y1" values="0;0;1;1;0" dur="3s" repeatCount="indefinite"/>
              <animate attributeName="x2" values="1;0;0;1;1" dur="3s" repeatCount="indefinite"/>
              <animate attributeName="y2" values="1;1;0;0;1" dur="3s" repeatCount="indefinite"/>
            {/if}
            <stop offset="0" stop-color="var(--accent)"/>
            <stop offset="0.5" stop-color="var(--accent-3)"/>
            <stop offset="1" stop-color="var(--accent-2)"/>
          </linearGradient>
          <filter id="arcglow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur in="SourceGraphic" stdDeviation="4">
              {#if !reduceMotion}
                <animate attributeName="stdDeviation" values="3;8;3" dur="2s" repeatCount="indefinite"/>
              {/if}
            </feGaussianBlur>
          </filter>
        </defs>
        <circle cx="63" cy="63" r="53" fill="none" stroke="var(--ring-track)" stroke-width="13"/>
        <circle class="arc-glow" cx="63" cy="63" r="53" fill="none" stroke="url(#rg)" stroke-width="16" stroke-linecap="round"
          filter="url(#arcglow)"
          stroke-dasharray={RING_C}
          stroke-dashoffset={RING_C * (1 - (fivePct ?? 0) / 100)}/>
        <circle class="arc" cx="63" cy="63" r="53" fill="none" stroke="url(#rg)" stroke-width="13" stroke-linecap="round"
          stroke-dasharray={RING_C}
          stroke-dashoffset={RING_C * (1 - (fivePct ?? 0) / 100)}/>
      </svg>
      <div class="val"><b>{fivePct ?? "–"}%</b><small>USED</small></div>
    </div>
    <div class="ring-info">
      <h3>5-hour block</h3>
      <div class="big">Current window</div>
      <div class="meta">
        Resets <em>{fmtClock(app.usage?.limits?.fiveHour?.resetsAt ?? null)}</em><br>
        {remaining(app.usage?.limits?.fiveHour?.resetsAt ?? null)}
      </div>
    </div>
  </div>

  <div class="glass glow card">
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

  <div class="glass glow card">
    <h3>{app.usage?.month?.since ? "This billing cycle" : "This month"}</h3>
    <div class="stat-big">{app.usage?.month ? fmtTokens(app.usage.month.totalTokens) : "–"}</div>
    <div class="stat-sub">
      tokens · <b>{app.usage?.month ? fmtUSD(app.usage.month.costUSD) : "–"}</b> API-equivalent
      {#if app.usage?.month?.since}<br>since {fmtDate(app.usage.month.since)}{/if}
    </div>
    {#if burnDays.length > 1}
      <div class="burn" role="img"
        aria-label="Daily token burn; peak {fmtTokens(burnMax)} on {fmtDay(burnDays.reduce((a, b) => b.tokens > a.tokens ? b : a).date)}">
        {#each burnDays as d, i (d.date)}
          <div class="burn-band" role="presentation"
            onpointerenter={() => burnTip = i} onpointerleave={() => burnTip = null}>
            {#if d.tokens > 0}
              <i class:today={i === burnDays.length - 1} class:hot={i === burnTip}
                style="height:{d.tokens / burnMax * 100}%"></i>
            {/if}
          </div>
        {/each}
        {#if burnTip !== null && burnDays[burnTip]}
          <div class="burn-tip" style="left:clamp(46px, {(burnTip + 0.5) / burnDays.length * 100}%, calc(100% - 46px))">
            <b>{fmtTokens(burnDays[burnTip].tokens)} tokens</b>
            <span>{fmtDay(burnDays[burnTip].date)} · {fmtUSD(burnDays[burnTip].costUSD)}</span>
          </div>
        {/if}
      </div>
      <div class="burn-axis">
        <span>{fmtDay(burnDays[0].date)}</span>
        <span>peak {fmtTokens(burnMax)}/day</span>
        <span>today</span>
      </div>
    {/if}
  </div>
</div>

{#if cx}
  <div class="glass glow card codex-card">
    <div class="cx-head">
      <h3>Codex</h3>
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
    </div>

    <div class="cx-body">
      {#if cx.mode === "oauth"}
        <div class="cx-bars">
          <div class="bar-label"><span>5-hour window</span><b>{cxFive ?? "–"}%</b></div>
          <div class="bar-frame"><div class="bar sub"><span class="bar-glow" style="width:{cxFive ?? 0}%"></span><i style="width:{cxFive ?? 0}%"></i></div></div>
          <div class="bar-label"><span>weekly</span><b>{cxWeek ?? "–"}%</b></div>
          <div class="bar-frame"><div class="bar sub"><span class="bar-glow alt" style="width:{cxWeek ?? 0}%"></span><i class="alt" style="width:{cxWeek ?? 0}%"></i></div></div>
          <div class="reset">
            {#if cx.limits?.fiveHour?.resetsAt}Resets <b>{fmtClock(cx.limits.fiveHour.resetsAt)}</b> · weekly <b>{fmtClock(cx.limits?.weekly?.resetsAt ?? null)}</b>{/if}
            {#if cx.limits?.asOf}<span class="cx-asof">snapshot {fmtAgo(new Date(cx.limits.asOf).getTime())}</span>{/if}
          </div>
        </div>
        <div class="cx-stat">
          <div class="cx-num">{cxSpend ? fmtTokens(cxSpend.oauth.tokens) : "–"}</div>
          <div class="cx-sub">subscription tokens this month<br>{cxSpend ? fmtUSD(cxSpend.oauth.costUSD) : "–"} API-equivalent value</div>
        </div>
        {#if cxSpend && cxSpend.api.tokens > 0}
          <div class="cx-stat cx-dim">
            <div class="cx-sub">API key this month<br>{fmtTokens(cxSpend.api.tokens)} tokens · {fmtUSD(cxSpend.api.costUSD)}</div>
          </div>
        {/if}
      {:else}
        <div class="cx-stat">
          <div class="cx-num">{cxSpend ? fmtUSD(cxSpend.api.costUSD) : "–"}</div>
          <div class="cx-sub">API spend this month</div>
        </div>
        <div class="cx-stat">
          <div class="cx-num">{cxSpend ? fmtTokens(cxSpend.api.tokens) : "–"}</div>
          <div class="cx-sub">API-key tokens this month</div>
        </div>
        {#if cxSpend && cxSpend.oauth.tokens > 0}
          <div class="cx-stat cx-dim">
            <div class="cx-sub">ChatGPT subscription this month<br>{fmtTokens(cxSpend.oauth.tokens)} tokens · {fmtUSD(cxSpend.oauth.costUSD)} API-equivalent</div>
          </div>
        {/if}
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
  /* Codex card — one wide strip under the Claude usage grid */
  .codex-card{margin-bottom:16px}
  .cx-head{display:flex;align-items:center;gap:14px}
  .cx-head h3{margin:0}
  .cx-note{font-size:11px;color:var(--ink-faint);margin-left:auto;text-align:right}
  .cx-err{color:var(--accent-2)}
  .cx-busy{opacity:.55;pointer-events:none}
  .cx-body{display:flex;align-items:flex-end;gap:34px;margin-top:14px}
  .cx-bars{flex:1;max-width:520px}
  .cx-bars .bar-label:first-child{margin-top:0}
  /* These bars are much wider than the Claude weekly card's, so the global
     160px-period animated gradient reads as repeating stripes here. Use one
     smooth static gradient across the full fill instead. */
  .cx-bars .bar i::before,.cx-bars .bar-glow::before{content:none}
  .cx-bars .bar-glow{background:linear-gradient(90deg,var(--accent),var(--accent-2))}
  .cx-bars .bar-glow.alt{background:linear-gradient(90deg,var(--accent-3),var(--accent-2))}
  .cx-asof{margin-left:12px;color:var(--ink-faint)}
  .cx-stat{flex:none}
  .cx-num{font-size:30px;font-weight:800;letter-spacing:-.02em;line-height:1.1;color:var(--ink)}
  .cx-sub{font-size:11px;color:var(--ink-faint);margin-top:3px;line-height:1.5}
  .cx-dim{margin-left:auto;text-align:right}
  @media (max-width:900px){.cx-body{flex-wrap:wrap;gap:18px}}

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

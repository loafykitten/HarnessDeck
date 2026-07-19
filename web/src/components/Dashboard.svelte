<script lang="ts">
  import { app, navigate } from "../lib/state.svelte";
  import { fmtAgo, fmtClock, fmtDate, fmtTokens, fmtUSD, initials, projectGradient } from "../lib/api";

  const RING_C = 333; // 2πr for r=53

  const fivePct = $derived(app.usage?.limits?.fiveHour?.pct ?? null);
  const weekPct = $derived(app.usage?.limits?.weekly?.pct ?? null);
  const liveCount = $derived(app.sessions.length);

  // daily token burn across the billing window
  const burnDays = $derived(app.usage?.month?.days ?? []);
  const burnMax = $derived(Math.max(...burnDays.map(d => d.tokens), 1));
  let burnTip = $state<number | null>(null);
  function fmtDay(iso: string): string {
    return new Date(iso + "T12:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function remaining(iso: string | null): string {
    if (!iso) return "";
    const mins = Math.max(0, Math.round((new Date(iso).getTime() - Date.now()) / 60000));
    const h = Math.floor(mins / 60), m = mins % 60;
    return h > 0 ? `~${h}h ${m}m remaining` : `~${m}m remaining`;
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
            <stop offset="0" stop-color="var(--accent)"/>
            <stop offset="1" stop-color="var(--accent-2)"/>
          </linearGradient>
        </defs>
        <circle cx="63" cy="63" r="53" fill="none" stroke="var(--ring-track)" stroke-width="13"/>
        <circle cx="63" cy="63" r="53" fill="none" stroke="url(#rg)" stroke-width="13" stroke-linecap="round"
          stroke-dasharray={RING_C}
          stroke-dashoffset={RING_C * (1 - (fivePct ?? 0) / 100)}
          style="filter:drop-shadow(0 0 8px var(--accent));transition:stroke-dashoffset .6s ease"/>
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
      <div class="bar"><i style="width:{weekPct ?? 0}%"></i></div>
      {#if app.usage?.limits?.weeklyModel}
        <div class="bar-label"><span>{app.usage.limits.weeklyModel.model}</span><b>{app.usage.limits.weeklyModel.pct}%</b></div>
        <div class="bar sub"><i class="alt" style="width:{app.usage.limits.weeklyModel.pct}%"></i></div>
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

<div class="grid lower-grid">
  <div class="glass glow sessions">
    <h3>Active sessions</h3>
    <div class="card-sub">One click to jump in</div>
    <div class="sess-list">
      {#each app.sessions as s, i (s.id)}
        <button class="sess-item" onclick={() => navigate({ view: "project", name: s.project, session: s.id })}>
          <div class="sess-ico" class:alt={i % 2 === 1}>{i % 2 === 0 ? "◈" : "⬡"}</div>
          <div class="sess-meta"><b>{s.project}</b><div class="s">active {fmtAgo(s.activity)}</div></div>
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

<script lang="ts">
  import { onMount } from "svelte";
  import { app, navigate } from "../../stores/state.svelte";
  import { fmtAgo, initials, projectGradient } from "../../utils/format";
  import ClaudeCard from "./ClaudeCard.svelte";
  import CodexCard from "./CodexCard.svelte";

  const liveCount = $derived(app.sessions.length);

  // 1s clock for the usage status line ("updated … · next in Ns") — only
  // ticks while the dashboard is mounted
  let now = $state(Date.now());
  onMount(() => {
    const t = setInterval(() => { now = Date.now(); }, 1000);
    return () => clearInterval(t);
  });
  const usageLine = $derived.by(() => {
    const st = app.usageStat;
    if (st.updatedAt === null) return null;
    const next = st.nextAt === null ? null : Math.max(0, Math.ceil((st.nextAt - now) / 1000));
    return `updated ${fmtAgo(st.updatedAt)}${next === null ? "" : ` · next in ${next}s`}`;
  });

  // Stable render order: the server sorts sessions by activity, which reshuffles
  // every 5s poll — that moves the keyed rows in the DOM and restarts their CSS
  // animations (status pulse). Sort by creation time (id tie-breaks) so a row
  // keeps its slot across refreshes; recency still shows via "active … ago".
  const sessions = $derived(
    [...app.sessions].sort((a, b) => a.created - b.created || a.id.localeCompare(b.id))
  );
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

<div class="usage-stat" aria-live="polite">
  {#if app.usageStat.refreshing}
    <span class="stat-spin">↻</span> checking usage…
  {:else if usageLine}
    {usageLine}
  {/if}
</div>

<ClaudeCard />
<CodexCard />

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
  /* usage freshness line — quiet, right-aligned, reserved height so the
     refreshing↔idle swap never shifts the cards below it */
  .usage-stat{display:flex;justify-content:flex-end;align-items:center;gap:5px;
    min-height:15px;margin:-4px 2px 4px;font-size:10px;letter-spacing:.06em;
    color:var(--ink-faint);font-variant-numeric:tabular-nums}
  .stat-spin{display:inline-block;animation:statspin 1.2s linear infinite}
  @keyframes statspin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.stat-spin{animation:none}}

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

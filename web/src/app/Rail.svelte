<script lang="ts">
  import { app, navigate, toggleTheme, gotoProjects } from "../stores/state.svelte";

  const isProjects = $derived(app.route.view === "project");
</script>

<aside class="rail" class:expanded={app.railExpanded}>
  <div class="rail-top">
    <button class="logo" onclick={() => app.railExpanded = !app.railExpanded}
      title={app.railExpanded ? "Collapse menu" : "Expand menu"}
      aria-label={app.railExpanded ? "Collapse menu" : "Expand menu"} aria-expanded={app.railExpanded}>
      {#if app.pet === "cybercat"}
        <svg viewBox="0 0 24 24" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-weight="700" text-anchor="middle">
          <text x="12" y="11" font-size="7">/\_/\</text>
          <text x="12" y="18" font-size="6.2">(o.o)</text>
        </svg>
      {:else if app.pet === "foxtrix"}
        <svg viewBox="0 0 24 24" fill="#fff" font-family="ui-monospace,Menlo,monospace" font-weight="700" text-anchor="middle">
          <text x="12" y="11" font-size="7">/\ /\</text>
          <text x="12" y="18" font-size="5.6">=(･ᴥ･)=</text>
        </svg>
      {:else}
        <!-- ophanim: wheel-within-wheel, many-eyed, claude-spark hub
             (rays point at the eyes) -->
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round">
          <circle cx="12" cy="12" r="8.6"/>
          <ellipse cx="12" cy="12" rx="8.6" ry="3.4"/>
          <ellipse cx="12" cy="12" rx="3.4" ry="8.6"/>
          <path stroke-width="1.1" d="M12 7.4V10.2M12 13.8V16.6M7.4 12H10.2M13.8 12H16.6M8.75 8.75 10.73 10.73M13.27 13.27 15.25 15.25M15.25 8.75 13.27 10.73M8.75 15.25 10.73 13.27"/>
          <circle cx="12" cy="12" r="0.7" fill="#fff" stroke="none"/>
          <circle cx="18.1" cy="5.9" r="0.7" fill="#fff" stroke="none"/>
          <circle cx="18.1" cy="18.1" r="0.7" fill="#fff" stroke="none"/>
          <circle cx="5.9" cy="5.9" r="0.7" fill="#fff" stroke="none"/>
          <circle cx="5.9" cy="18.1" r="0.7" fill="#fff" stroke="none"/>
        </svg>
      {/if}
    </button>
    <div class="brandtext"><b>HarnessDeck</b><span>control center</span></div>
  </div>

  <nav class="rail-nav">
    <button class="rail-item" class:active={app.route.view === "dash"} data-tip="Dashboard ⌃1" onclick={() => navigate({ view: "dash" })}>
      <span class="ico"><svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/></svg></span>
      <span class="lbl">Dashboard</span>
    </button>
    <button class="rail-item" class:active={isProjects} data-tip="Projects ⌃2" onclick={gotoProjects}>
      <span class="ico"><svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg></span>
      <span class="lbl">Projects</span>
    </button>
    <button class="rail-item" class:active={app.route.view === "skills"} data-tip="Skills ⌃3" onclick={() => navigate({ view: "skills" })}>
      <span class="ico"><svg viewBox="0 0 24 24"><path d="M12 3l2.4 5 5.6.6-4.2 3.8 1.2 5.6L12 15.8 6.9 18 8 12.4 3.8 8.6 9.4 8z"/></svg></span>
      <span class="lbl">Skills</span>
    </button>
    <button class="rail-item" class:active={app.route.view === "config"} data-tip="Config ⌃4" onclick={() => navigate({ view: "config" })}>
      <span class="ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3.2"/><path d="M12 2v3M12 19v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2 12h3M19 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg></span>
      <span class="lbl">Config</span>
    </button>
  </nav>

  <div class="rail-spacer"></div>

  <div class="rail-bottom">
    <button class="rail-item" data-tip="Theme" onclick={toggleTheme}>
      <span class="ico"><svg viewBox="0 0 24 24"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg></span>
      <span class="lbl">Theme</span>
      <span class="theme-swatch"><span class="tdotc b1"></span><span class="tdotc b2"></span><span class="tdotc b3"></span></span>
    </button>
  </div>
</aside>

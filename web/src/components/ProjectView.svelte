<script lang="ts">
  import { app, navigate, projectSessions, refreshCore } from "../lib/state.svelte";
  import { api, fmtAgo } from "../lib/api";
  import Terminal from "./Terminal.svelte";
  import Mascot from "./Mascot.svelte";

  let { project }: { project: string } = $props();

  const mySessions = $derived(projectSessions(project));
  const projInfo = $derived(app.projects.find(p => p.name === project));

  // Which session tab is open. The route is the source of truth (hotkeys
  // cycle tabs by navigating); an invalid/absent route session → first tab.
  const activeId = $derived.by(() => {
    const routeSession = app.route.view === "project" ? app.route.session : undefined;
    if (routeSession && mySessions.some(s => s.id === routeSession)) return routeSession;
    return mySessions[0]?.id ?? null;
  });

  function selectTab(id: string) {
    navigate({ view: "project", name: project, session: id });
  }

  let naming = $state(false);
  let newName = $state("");
  let creating = $state(false);
  let createError = $state("");

  async function createNew() {
    const name = newName.trim() || `session-${mySessions.length + 1}`;
    creating = true;
    createError = "";
    try {
      const { id } = await api.createSession(project, name);
      naming = false;
      newName = "";
      await refreshCore();
      selectTab(id);
    } catch (e) {
      createError = e instanceof Error ? e.message : "failed";
    } finally {
      creating = false;
    }
  }

  async function closeSession(id: string) {
    if (!confirm("Kill this session? The Claude process will be terminated.")) return;
    await api.killSession(id).catch(console.error);
    await refreshCore();
  }

  const activeSession = $derived(mySessions.find(s => s.id === activeId));

  const STATUS_LABEL = { working: "working", waiting: "needs you", idle: "idle" } as const;
</script>

<div class="glass glow pv-head">
  <button class="pv-back" onclick={() => navigate({ view: "dash" })}>‹ Back</button>
  <div class="pv-title">
    <b>{project}</b>
    <span class="pv-path mono">{projInfo?.dir?.replace(/^\/Users\/[^/]+/, "~") ?? ""}</span>
  </div>
  <div class="pv-metas">
    {#if mySessions.length > 0}
      <span class="pill"><span class="live-dot"></span> {mySessions.length} session{mySessions.length === 1 ? "" : "s"} running</span>
    {/if}
    <span class="pill">last activity {fmtAgo(projInfo?.lastActivity ?? null)}</span>
  </div>
</div>

<div class="term-wrap">
  <div class="tabs" role="tablist" aria-orientation="vertical">
    {#each mySessions as s (s.id)}
      <div class="tab" class:active={s.id === activeId}
        role="tab" tabindex="0" aria-selected={s.id === activeId}
        onclick={() => selectTab(s.id)}
        onkeydown={(e) => e.key === "Enter" && selectTab(s.id)}>
        <span class="tdot {s.status}"></span>
        <span class="tab-info">
          <span class="tab-name">{s.name}</span>
          <span class="tab-meta"><span class="st {s.status}">{STATUS_LABEL[s.status]}</span> · {fmtAgo(s.activity)}</span>
        </span>
        <span class="tab-x" role="button" tabindex="0" aria-label="Kill session"
          onclick={(e) => { e.stopPropagation(); closeSession(s.id); }}
          onkeydown={(e) => e.key === "Enter" && (e.stopPropagation(), closeSession(s.id))}>✕</span>
      </div>
    {/each}
    {#if naming}
      <div class="tab new">
        <!-- svelte-ignore a11y_autofocus -->
        <input autofocus placeholder="session name…" bind:value={newName}
          onkeydown={(e) => { if (e.key === "Enter") createNew(); if (e.key === "Escape") { naming = false; createError = ""; } }}
          onblur={() => { if (!creating) { naming = false; createError = ""; } }} />
      </div>
    {:else}
      <div class="tab new" role="button" tabindex="0"
        onclick={() => naming = true}
        onkeydown={(e) => e.key === "Enter" && (naming = true)}>+ new session</div>
    {/if}
    {#if createError}<div class="tab" style="color:#ff5f57">{createError}</div>{/if}
  </div>

  <div class="term-col">
    {#if mySessions.length > 0}
      <div class="glass term">
        <div class="term-bar">
          <div class="tl"><i></i><i></i><i></i></div>
          <span class="tt">{activeSession?.name ?? ""} — claude</span>
          <span class="rt">{project}</span>
        </div>
        {#each mySessions as s (s.id)}
          <Terminal sessionId={s.id} active={s.id === activeId} onEnded={refreshCore} />
        {/each}
      </div>
    {:else}
      <div class="glass term">
        <div class="pv-empty">
          <div class="big">No sessions in {project} yet</div>
          <div>Spin one up — it runs in tmux and survives restarts.</div>
          <button class="btn" onclick={() => { naming = true; }}>+ Start a session</button>
        </div>
      </div>
    {/if}

    {#if mySessions.length > 0}
      <Mascot />
    {/if}
  </div>
</div>

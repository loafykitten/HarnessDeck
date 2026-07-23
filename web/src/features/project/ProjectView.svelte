<script lang="ts">
  import { onMount, untrack } from "svelte";
  import "@xterm/xterm/css/xterm.css";
  import { app, navigate, projectSessions, refreshCore } from "../../stores/state.svelte";
  import { getChatSessionsStore, projectMode, setProjectMode } from "../../stores/chatSessions.svelte";
  import { api } from "../../lib/api";
  import { fmtAgo } from "../../utils/format";
  import type { HarnessId } from "../../types/api";
  import FileTree from "./FileTree.svelte";
  import Terminal from "./Terminal.svelte";
  import Chat from "./chat/Chat.svelte";
  import Mascot from "../../components/pets/Mascot.svelte";

  let { project }: { project: string } = $props();

  const mySessions = $derived(projectSessions(project));
  const chatSessions = $derived(getChatSessionsStore(project));
  const projInfo = $derived(app.projects.find(p => p.name === project));

  // Mode is derived, not imperatively synced: a route session that belongs to
  // either list wins (so deep links and hotkeys land in the right mode), the
  // sticky per-project preference is only the fallback. An effect that flipped
  // the store instead proved unreliable during the initial load cascade.
  const columnMode = $derived.by(() => {
    const routeSession = app.route.view === "project" ? app.route.session : undefined;
    if (routeSession) {
      if (mySessions.some(s => s.id === routeSession)) return "terminal";
      if (chatSessions.sessions.some(s => s.id === routeSession)) return "chat";
    }
    return projectMode(project);
  });

  // Which session tab is open. The route is the source of truth (hotkeys
  // cycle tabs by navigating); an invalid/absent route session → first tab.
  const activeId = $derived.by(() => {
    const routeSession = app.route.view === "project" ? app.route.session : undefined;
    const sessions = columnMode === "chat" ? chatSessions.sessions : mySessions;
    if (routeSession && sessions.some(s => s.id === routeSession)) return routeSession;
    return sessions[0]?.id ?? null;
  });

  function selectTab(id: string) {
    navigate({ view: "project", name: project, session: id });
  }

  function selectMode(mode: "terminal" | "chat") {
    if (mode === columnMode) return;
    navigate({ view: "project", name: project });
    setProjectMode(project, mode);
  }

  let naming = $state(false);
  let newName = $state("");
  let creating = $state(false);
  let createError = $state("");
  let stack = $state<string[]>([]);
  let filesCollapsed = $state(localStorage.getItem("hd-files-collapsed") === "1");
  let fileTree = $state<{ refresh: () => Promise<void> } | null>(null);
  let refreshing = $state(false);

  $effect(() => {
    const routeSession = app.route.view === "project" ? app.route.session : undefined;
    if (columnMode === "chat" || (routeSession && !mySessions.some(s => s.id === routeSession))) {
      void untrack(() => chatSessions.load());
    }
  });

  // Persist the effective mode so it sticks once the route no longer names a
  // session (back from dashboard, mode toggle). No-ops on unchanged mode.
  $effect(() => {
    setProjectMode(project, columnMode);
  });

  onMount(async () => {
    try { stack = (await api.projectStack(project)).stack; } catch { /* header works without stack metadata */ }
  });

  function setFilesCollapsed(value: boolean) {
    filesCollapsed = value;
    localStorage.setItem("hd-files-collapsed", value ? "1" : "0");
  }

  async function refreshFiles() {
    if (!fileTree || refreshing) return;
    refreshing = true;
    try { await fileTree.refresh(); } finally { refreshing = false; }
  }

  // Sidebar (tabs + files) width — draggable via the divider, persisted.
  const SIDE_MIN = 170, SIDE_MAX = 520;
  const clampSide = (w: number) => Math.min(SIDE_MAX, Math.max(SIDE_MIN, w));
  let sideWidth = $state(clampSide(Number(localStorage.getItem("hd-side-width")) || 236));
  let dragging = $state(false);

  function startResize(e: PointerEvent) {
    const startX = e.clientX, startW = sideWidth;
    const handle = e.currentTarget as HTMLElement;
    handle.setPointerCapture(e.pointerId);
    dragging = true;
    const move = (ev: PointerEvent) => { sideWidth = clampSide(startW + ev.clientX - startX); };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      dragging = false;
      localStorage.setItem("hd-side-width", String(sideWidth));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up, { once: true });
    e.preventDefault();
  }

  function resizeKeydown(e: KeyboardEvent) {
    const step = e.shiftKey ? 32 : 12;
    if (e.key === "ArrowLeft") sideWidth = clampSide(sideWidth - step);
    else if (e.key === "ArrowRight") sideWidth = clampSide(sideWidth + step);
    else return;
    e.preventDefault();
    localStorage.setItem("hd-side-width", String(sideWidth));
  }

  // Which harness the next session runs. Sticky across visits; Shift+Tab
  // cycles it while the name input has focus.
  const savedHarness = localStorage.getItem("hd-new-harness");
  let newHarness = $state<HarnessId>(
    app.harnesses.some(h => h.id === savedHarness) ? savedHarness as HarnessId : "claude");

  function cycleHarness(dir: 1 | -1 = 1) {
    const ids = app.harnesses.map(h => h.id);
    const i = ids.indexOf(newHarness);
    newHarness = ids[(i + dir + ids.length) % ids.length];
    localStorage.setItem("hd-new-harness", newHarness);
  }

  function pickHarness(id: HarnessId) {
    newHarness = id;
    localStorage.setItem("hd-new-harness", id);
  }

  function namingKeydown(e: KeyboardEvent) {
    if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleHarness(); return; }
    if (e.key === "Enter") createNew();
    if (e.key === "Escape") { naming = false; createError = ""; }
  }

  async function createNew() {
    const name = newName.trim() || `session-${mySessions.length + 1}`;
    creating = true;
    createError = "";
    try {
      const { id } = await api.createSession(project, name, newHarness);
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

  async function closeChat(id: string, name: string) {
    if (!confirm(`Delete chat “${name}”? Its running agent will stop.`)) return;
    await chatSessions.remove(id).catch(() => {});
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
  <div class="pv-side">
  <div class="pv-metas">
    {#if mySessions.length > 0}
      <span class="pill"><span class="live-dot"></span> {mySessions.length} session{mySessions.length === 1 ? "" : "s"} running</span>
    {/if}
    <span class="pill">last activity {fmtAgo(projInfo?.lastActivity ?? null)}</span>
    {#if projInfo?.git?.branch && !["main", "master", "HEAD"].includes(projInfo.git.branch)}
      <span class="pill mono">{projInfo.git.branch}</span>
    {/if}
    {#if projInfo?.git?.ahead && projInfo.git.ahead > 0}
      <span class="pill" style="color:var(--accent)">↑{projInfo.git.ahead} to push</span>
    {/if}
    {#if projInfo?.git?.dirty && projInfo.git.dirty > 0}
      <span class="pill">{projInfo.git.dirty} uncommitted</span>
    {/if}
    {#if projInfo?.git?.branches.length}
      <span class="pill" title={projInfo.git.branches.join(", ")}>+{projInfo.git.branches.length} branch{projInfo.git.branches.length === 1 ? "" : "es"}</span>
    {/if}
    {#if projInfo?.git?.worktrees.length}
      <span class="pill" title={projInfo.git.worktrees.map(w => w.branch).join(", ")}>{projInfo.git.worktrees.length} worktree{projInfo.git.worktrees.length === 1 ? "" : "s"}</span>
    {/if}
  </div>
  {#if stack.length > 0}
    <div class="pv-metas pv-stack">
      {#each stack as technology (technology)}
        <span class="pill stack-pill">{technology}</span>
      {/each}
    </div>
  {/if}
  </div>
</div>

<div class="term-wrap">
  <div class="side-col" style:width="{sideWidth}px">
  <div class="tabs" role="tablist" aria-orientation="vertical">
    {#if columnMode === "chat"}
      {#each chatSessions.sessions as s (s.id)}
        <div class="tab" class:active={s.id === activeId}
          role="tab" tabindex="0" aria-selected={s.id === activeId}
          onclick={() => selectTab(s.id)}
          onkeydown={(e) => e.key === "Enter" && selectTab(s.id)}>
          {#if s.id === activeId}<span class="tab-nub" aria-hidden="true"><i></i></span>{/if}
          <span class="tdot {s.status}"></span>
          <span class="tab-info">
            <span class="tab-name">{s.name}</span>
            <span class="tab-meta"><span class="hx {s.harness}">{s.harness}</span> <span class="st {s.status}">{STATUS_LABEL[s.status]}</span></span>
            <span class="tab-time">{fmtAgo(s.lastActivity)}</span>
          </span>
          <span class="tab-x" role="button" tabindex="0" aria-label={`Delete ${s.name}`}
            onclick={(e) => { e.stopPropagation(); closeChat(s.id, s.name); }}
            onkeydown={(e) => e.key === "Enter" && (e.stopPropagation(), closeChat(s.id, s.name))}>✕</span>
        </div>
      {/each}
      <div class="tab new" role="button" tabindex="0"
        onclick={() => chatSessions.showForm = true}
        onkeydown={(e) => e.key === "Enter" && (chatSessions.showForm = true)}>+ new chat</div>
    {:else}
      {#each mySessions as s (s.id)}
        <div class="tab" class:active={s.id === activeId}
          role="tab" tabindex="0" aria-selected={s.id === activeId}
          onclick={() => selectTab(s.id)}
          onkeydown={(e) => e.key === "Enter" && selectTab(s.id)}>
          {#if s.id === activeId}<span class="tab-nub" aria-hidden="true"><i></i></span>{/if}
          <span class="tdot {s.status}"></span>
          <span class="tab-info">
            <span class="tab-name">{s.name}</span>
            <span class="tab-meta"><span class="hx {s.harness}">{s.harness}</span> <span class="st {s.status}">{STATUS_LABEL[s.status]}</span></span>
            <span class="tab-time">{fmtAgo(s.activity)}</span>
          </span>
          <span class="tab-x" role="button" tabindex="0" aria-label="Kill session"
            onclick={(e) => { e.stopPropagation(); closeSession(s.id); }}
            onkeydown={(e) => e.key === "Enter" && (e.stopPropagation(), closeSession(s.id))}>✕</span>
        </div>
      {/each}
      {#if naming}
        <div class="tab new naming">
          <!-- svelte-ignore a11y_autofocus -->
          <input autofocus placeholder="session name…" bind:value={newName}
            onkeydown={namingKeydown}
            onblur={() => { if (!creating) { naming = false; createError = ""; } }} />
          <!-- mousedown-preventDefault keeps the input focused so its onblur
               doesn't dismiss the form before the click lands -->
          <div class="harness-pick" role="radiogroup" aria-label="Harness">
            {#each app.harnesses as h (h.id)}
              <button class="hopt" class:on={h.id === newHarness} role="radio" aria-checked={h.id === newHarness}
                onmousedown={(e) => e.preventDefault()}
                onclick={() => pickHarness(h.id)}>{h.label}</button>
            {/each}
          </div>
          <span class="hint">⇧⇥ switches harness</span>
        </div>
      {:else}
        <div class="tab new" role="button" tabindex="0"
          onclick={() => naming = true}
          onkeydown={(e) => e.key === "Enter" && (naming = true)}>+ new session</div>
      {/if}
      {#if createError}<div class="tab" style="color:#ff5f57">{createError}</div>{/if}
    {/if}
  </div>

  {#if filesCollapsed}
    <button class="glass files-slim" title="Show files" aria-label="Show files"
      onclick={() => setFilesCollapsed(false)}>
      <span>▸</span><b>Files</b>
    </button>
  {:else}
    <aside class="glass files-panel" aria-label="Project files">
      <div class="files-head">
        <button class="files-title" title="Collapse files" aria-label="Collapse files"
          onclick={() => setFilesCollapsed(true)}><span class="open">▸</span><b>Files</b></button>
        <button class="files-refresh" class:refreshing title="Refresh files" aria-label="Refresh files"
          aria-busy={refreshing} disabled={refreshing} onclick={refreshFiles}><span>⟳</span></button>
      </div>
      <FileTree bind:this={fileTree} {project} />
    </aside>
  {/if}
  </div>

  <!-- ARIA window-splitter: a focusable separator is interactive by spec -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
  <div class="side-resize" class:dragging role="separator" aria-orientation="vertical"
    aria-label="Resize sidebar" aria-valuemin={SIDE_MIN} aria-valuemax={SIDE_MAX} aria-valuenow={sideWidth}
    tabindex="0" onpointerdown={startResize} onkeydown={resizeKeydown}></div>

  <div class="term-col">
    <div class="column-mode glass" role="group" aria-label="Project workspace mode">
      <button class:on={columnMode === "terminal"} aria-pressed={columnMode === "terminal"}
        onclick={() => selectMode("terminal")}>Terminal</button>
      <button class:on={columnMode === "chat"} aria-pressed={columnMode === "chat"}
        onclick={() => selectMode("chat")}>Chat</button>
    </div>
    {#if columnMode === "chat"}
      <Chat {project} branch={projInfo?.git?.branch} {activeId} />
    {:else if mySessions.length > 0}
      <div class="glass term">
        <div class="term-bar">
          <div class="tl"><i></i><i></i><i></i></div>
          <span class="tt">{activeSession?.name ?? ""} — {activeSession?.harness ?? "claude"}</span>
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
  </div>
</div>

<div class="glass pet-home" aria-hidden="true">
  <Mascot />
</div>

<style>
  /* harness picker inside the new-session tab (.hx chips are global) */
  .tab.naming{flex-direction:column;align-items:stretch;gap:7px}
  .harness-pick{display:flex;gap:4px}
  .hopt{flex:1;font:inherit;font-size:10px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;
    cursor:pointer;padding:4px 0;border-radius:7px;border:1px solid var(--glass-brd);
    background:transparent;color:var(--ink-faint)}
  .hopt:hover{color:var(--ink-dim)}
  .hopt.on{color:var(--ink);background:var(--glass-brd);border-color:var(--glass-brd-lit)}
  .tab.naming .hint{font-size:9.5px;color:var(--ink-faint);text-align:center;letter-spacing:.04em}
  .pv-side{margin-left:auto;display:flex;flex-direction:column;gap:7px;align-items:flex-end}
  .pv-side .pv-metas{margin-left:0;justify-content:flex-end}
  @media (max-width:720px){
    .pv-side{width:100%;align-items:flex-start}
    .pv-side .pv-metas{width:100%;justify-content:flex-start}
  }
  .stack-pill{color:var(--accent-2);border-color:var(--accent-2);background:var(--glass-2)}
  /* the pet's home: a full-width strip under the terminal + files row */
  .pet-home{flex:none;margin-top:14px;border-radius:15px;overflow:hidden;padding:0 10px}
  .pet-home :global(.mascot-track){margin-top:0}
  /* left sidebar: session tabs stacked over the files panel; the divider drags its width */
  .side-col{flex:none;min-width:0;display:flex;flex-direction:column;gap:14px}
  .side-resize{flex:none;align-self:stretch;width:12px;margin:0 -7px;cursor:col-resize;
    position:relative;z-index:4;border-radius:6px;touch-action:none}
  .side-resize::before{content:"";position:absolute;left:5px;top:0;bottom:0;width:2px;border-radius:2px;
    background:var(--glass-brd);opacity:0;transition:.18s}
  .side-resize:hover::before,.side-resize:focus-visible::before,.side-resize.dragging::before{
    opacity:1;background:var(--accent-2);box-shadow:0 0 10px rgba(var(--accent-2-rgb),.7)}
  .files-panel{width:100%;flex:1;min-height:180px;overflow:hidden;border-radius:15px;
    display:flex;flex-direction:column}
  .files-head{height:42px;display:flex;align-items:center;padding:0 9px 0 7px;
    border-bottom:1px solid var(--glass-brd);background:var(--glass)}
  .files-title{display:flex;align-items:center;gap:7px;min-width:0;flex:1;padding:7px;color:var(--ink-dim);text-align:left}
  .files-title:hover{color:var(--ink)}
  .files-title span,.files-slim span{width:9px;color:var(--ink-faint)}
  .files-title span.open{transform:rotate(90deg)}
  .files-title b,.files-slim b{font-size:12px;letter-spacing:.04em}
  .files-refresh{width:28px;height:28px;border-radius:8px;color:var(--ink-faint);font-size:16px}
  .files-refresh:hover{color:var(--accent-2);background:var(--glass-2)}
  .files-refresh span{display:block}
  .files-refresh.refreshing span{animation:file-refresh-spin .7s linear infinite}
  @keyframes file-refresh-spin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){.files-refresh.refreshing span{animation-duration:1.4s}}
  .files-slim{width:100%;flex:none;min-height:42px;border-radius:13px;display:flex;
    align-items:center;justify-content:flex-start;gap:7px;padding:0 9px 0 14px;color:var(--ink-dim)}
  .files-slim:hover{color:var(--ink);border-color:var(--glass-brd-lit);box-shadow:0 0 18px -8px var(--accent)}
  @media (max-width:720px){
    /* stacked layout: dissolve the sidebar so tabs, terminal, files flow in
       .term-wrap's column — files drop below the terminal via order */
    .side-col{display:contents}
    .side-resize{display:none}
    .files-panel,.files-slim{order:2}
  }
</style>

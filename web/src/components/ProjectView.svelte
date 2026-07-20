<script lang="ts">
  import { app, navigate, projectSessions, refreshCore } from "../lib/state.svelte";
  import { api, fmtAgo, type HarnessId } from "../lib/api";
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
          <span class="tab-meta"><span class="hx {s.harness}">{s.harness}</span> <span class="st {s.status}">{STATUS_LABEL[s.status]}</span> · {fmtAgo(s.activity)}</span>
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
  </div>

  <div class="term-col">
    {#if mySessions.length > 0}
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

    {#if mySessions.length > 0}
      <Mascot />
    {/if}
  </div>
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
</style>

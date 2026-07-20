<script lang="ts">
  import { api, fmtAgo, type HarnessId, type SkillDetail, type SkillSummary } from "../lib/api";
  import { app, navigate } from "../lib/state.svelte";

  let skills = $state<SkillSummary[]>([]);
  let loaded = $state(false);

  // per-harness filter for the list
  let filter = $state<"all" | HarnessId>("all");
  const shown = $derived.by(() => {
    const f = filter; // snapshot so TS narrows inside the callback
    return f === "all" ? skills : skills.filter(s => s.harnesses.includes(f));
  });

  // sync a skill into another harness's skills dir
  let syncBusy = $state(false);
  let syncMsg = $state<{ ok: boolean; msg: string } | null>(null);
  async function syncTo(h: HarnessId) {
    if (!detail || syncBusy) return;
    syncBusy = true;
    syncMsg = null;
    try {
      await api.syncSkill(detail.name, h);
      detail = await api.skill(detail.name);
      syncMsg = { ok: true, msg: `copied to ${h}` };
      refresh();
    } catch (e) {
      syncMsg = { ok: false, msg: e instanceof Error ? e.message : "sync failed" };
    } finally {
      syncBusy = false;
      setTimeout(() => syncMsg = null, 3500);
    }
  }

  // drill-in
  let detail = $state<SkillDetail | null>(null);
  let openFile = $state("SKILL.md");
  let fileText = $state("");
  let fileDirty = $state(false);
  let saveStatus = $state<{ ok: boolean; msg: string } | null>(null);

  // install / generate
  let installUrl = $state("");
  let installBusy = $state(false);
  let installMsg = $state<{ ok: boolean; msg: string } | null>(null);
  let genName = $state("");
  let genPrompt = $state("");
  let genJob = $state<string | null>(null);
  let genMsg = $state<{ ok: boolean; msg: string } | null>(null);

  const routeName = $derived(app.route.view === "skills" ? app.route.name : undefined);

  async function refresh() {
    try { skills = await api.skills(); } catch (e) { console.error(e); }
    loaded = true;
  }
  refresh();

  $effect(() => {
    if (routeName) openSkill(routeName);
    else detail = null;
  });

  async function openSkill(name: string) {
    if (detail?.name === name) return;
    try {
      detail = await api.skill(name);
      await pickFile("SKILL.md");
    } catch {
      navigate({ view: "skills" });
    }
  }

  async function pickFile(path: string) {
    if (!detail) return;
    if (fileDirty && !confirm("Discard unsaved changes?")) return;
    openFile = path;
    fileDirty = false;
    const f = detail.files.find(x => x.path === path);
    fileText = f?.editable
      ? await api.skillFile(detail.name, path).catch(() => "(failed to load)")
      : `(${f ? "binary or oversized" : "missing"} file — not editable here)`;
  }

  async function saveFile() {
    if (!detail) return;
    try {
      await api.saveSkillFile(detail.name, openFile, fileText);
      fileDirty = false;
      saveStatus = { ok: true, msg: "saved" };
    } catch (e) {
      saveStatus = { ok: false, msg: String(e) };
    }
    setTimeout(() => saveStatus = null, 3000);
  }

  async function removeSkill() {
    if (!detail) return;
    const dirs = detail.harnesses.map(h => app.harnesses.find(x => x.id === h)?.label ?? h).join(" and ");
    if (!confirm(`Delete the skill "${detail.name}"? This removes it permanently from ${dirs}.`)) return;
    await api.deleteSkill(detail.name).catch(console.error);
    detail = null;
    navigate({ view: "skills" });
    refresh();
  }

  async function install() {
    if (!installUrl.trim()) return;
    installBusy = true;
    installMsg = null;
    try {
      const res = await api.installSkill(installUrl.trim());
      const parts = [];
      if (res.installed.length) parts.push(`installed: ${res.installed.join(", ")}`);
      if (res.skipped.length) parts.push(`already present: ${res.skipped.join(", ")}`);
      installMsg = { ok: res.installed.length > 0, msg: parts.join(" · ") || "nothing installed" };
      installUrl = "";
      refresh();
    } catch (e) {
      installMsg = { ok: false, msg: e instanceof Error ? e.message : "install failed" };
    } finally {
      installBusy = false;
    }
  }

  async function generate() {
    if (!genName.trim() || !genPrompt.trim()) {
      genMsg = { ok: false, msg: "name and prompt are both required" };
      return;
    }
    genMsg = null;
    try {
      const { job } = await api.generateSkill(genName.trim(), genPrompt.trim());
      genJob = job;
      poll(job);
    } catch (e) {
      genMsg = { ok: false, msg: e instanceof Error ? e.message : "failed to start" };
    }
  }

  function poll(id: string) {
    const t = setInterval(async () => {
      try {
        const job = await api.skillJob(id);
        if (job.status === "running") return;
        clearInterval(t);
        genJob = null;
        if (job.status === "done") {
          genMsg = { ok: true, msg: `"${job.skillName}" created` };
          genName = ""; genPrompt = "";
          await refresh();
          navigate({ view: "skills", name: job.skillName });
        } else {
          genMsg = { ok: false, msg: job.error ?? "generation failed" };
        }
      } catch {
        clearInterval(t);
        genJob = null;
        genMsg = { ok: false, msg: "lost track of the job" };
      }
    }, 2000);
  }
</script>

{#if detail}
  <!-- ============ DRILL-IN EDITOR ============ -->
  <div class="glass glow pv-head">
    <button class="pv-back" onclick={() => { detail = null; navigate({ view: "skills" }); }}>‹ Skills</button>
    <div class="pv-title">
      <b class="mono">{detail.name}</b>
      <span class="pv-path">{detail.frontmatter.description?.slice(0, 110) ?? ""}</span>
    </div>
    <div class="pv-metas">
      <span class="pill hx-pill" title={detail.harnesses.length > 1 ? "Owned by several harnesses — edits here update every copy" : ""}>
        {#each detail.harnesses as h (h)}<span class="hx {h}">{h}</span>{/each}
        {#if detail.harnesses.length > 1}<span class="hx-note">edits update all</span>{/if}
      </span>
      {#each app.harnesses.filter(h => !detail!.harnesses.includes(h.id)) as h (h.id)}
        <button class="btn ghost" style="margin-top:0" disabled={syncBusy}
          onclick={() => syncTo(h.id)}>Sync to {h.label}</button>
      {/each}
      {#if syncMsg}<span class="cfg-status" class:ok={syncMsg.ok} class:bad={!syncMsg.ok}>{syncMsg.msg}</span>{/if}
      <button class="btn ghost" style="margin-top:0" onclick={removeSkill}>Delete skill</button>
    </div>
  </div>

  <div class="term-wrap">
    <div class="tabs">
      {#each detail.files as f (f.path)}
        <div class="tab" class:active={f.path === openFile}
          role="tab" tabindex="0" aria-selected={f.path === openFile}
          onclick={() => pickFile(f.path)}
          onkeydown={(e) => e.key === "Enter" && pickFile(f.path)}>
          {f.path}{f.path === openFile && fileDirty ? " •" : ""}
        </div>
      {/each}
    </div>
    <div class="glass term">
      <div class="skill-editor-wrap">
        <textarea class="cfg-editor skill-editor" bind:value={fileText} spellcheck="false"
          oninput={() => fileDirty = true}
          disabled={!detail.files.find(f => f.path === openFile)?.editable}></textarea>
      </div>
      <div class="input-hint">
        <button class="btn" style="margin-top:0" onclick={saveFile} disabled={!fileDirty}>Save {openFile}</button>
        {#if saveStatus}<span class="cfg-status" class:ok={saveStatus.ok} class:bad={!saveStatus.ok}>{saveStatus.msg}</span>{/if}
      </div>
    </div>
  </div>
{:else}
  <!-- ============ LIST + NEW ============ -->
  <div class="greet-row">
    <div class="greet"><h1>Skills</h1></div>
    <div class="head-side">
      <div class="je-modes">
        <button class="je-mode" class:on={filter === "all"} onclick={() => filter = "all"}>All</button>
        {#each app.harnesses as h (h.id)}
          <button class="je-mode" class:on={filter === h.id} onclick={() => filter = h.id}>{h.label}</button>
        {/each}
      </div>
      <span class="pill">{shown.length} skill{shown.length === 1 ? "" : "s"}</span>
    </div>
  </div>

  <div class="proj-section" style="padding-top:0">
    <div class="proj-grid skills-grid">
      {#each shown as s (s.name)}
        <button class="pcard skill-card" onclick={() => navigate({ view: "skills", name: s.name })}>
          <div class="ptop">
            <span class="pav skill-pav">✦</span><b class="mono">{s.name}</b>
            <span class="hx-row">{#each s.harnesses as h (h)}<span class="hx {h}">{h}</span>{/each}</span>
          </div>
          <div class="skill-desc">{s.description || "(no description)"}</div>
          <div class="pstatus"><span class="mini-dot off"></span>{s.files} file{s.files === 1 ? "" : "s"} · updated {fmtAgo(s.updated)}</div>
        </button>
      {:else}
        {#if loaded}
          <div class="sess-empty">{filter === "all" ? "No skills installed yet — add one below." : `No ${filter} skills yet — sync one over from its detail page.`}</div>
        {/if}
      {/each}
    </div>
  </div>

  <div class="cfg-grid" style="margin-top:20px">
    <div class="glass glow cfg-card">
      <h3>Install from URL</h3>
      <div class="card-sub" style="margin-bottom:12px">A git repo or .zip containing SKILL.md (collections work too).</div>
      <div class="cfg-row">
        <input type="text" bind:value={installUrl} placeholder="https://github.com/user/skill.git"
          onkeydown={(e) => e.key === "Enter" && install()} />
      </div>
      <button class="btn" onclick={install} disabled={installBusy}>
        {installBusy ? "Installing…" : "Install"}
      </button>
      {#if installMsg}<span class="cfg-status" class:ok={installMsg.ok} class:bad={!installMsg.ok}>{installMsg.msg}</span>{/if}
    </div>

    <div class="glass glow cfg-card">
      <h3>Generate with Claude</h3>
      <div class="card-sub" style="margin-bottom:12px">Describe the skill; a headless Claude session scaffolds it.</div>
      <div class="cfg-row">
        <label for="gen-name">Skill name</label>
        <input id="gen-name" type="text" bind:value={genName} placeholder="deploy-checklist" />
      </div>
      <div class="cfg-row">
        <label for="gen-prompt">What should it do?</label>
        <textarea id="gen-prompt" class="cfg-editor" style="min-height:110px" bind:value={genPrompt}
          placeholder="Walk through my release checklist: run tests, bump the version, tag, build, notarize…"></textarea>
      </div>
      <button class="btn" onclick={generate} disabled={genJob !== null}>
        {genJob ? "Summoning…" : "Generate"}
      </button>
      {#if genJob}<span class="cfg-status ok gen-spin">✦ Claude is writing the skill (up to a few minutes)</span>{/if}
      {#if genMsg}<span class="cfg-status" class:ok={genMsg.ok} class:bad={!genMsg.ok}>{genMsg.msg}</span>{/if}
    </div>
  </div>
{/if}

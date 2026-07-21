<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../lib/api";
  import type { AppConfig, CodexMode, HarnessId } from "../../types/api";
  import { PETS, type PetId } from "../../components/pets/pets";
  import { app, applyPet, refreshGreeting, refreshUsage } from "../../stores/state.svelte";
  import JsonNode from "./JsonNode.svelte";

  let cfg = $state<AppConfig>({ displayName: "", zip: "", greetingEnabled: true, renewalDay: null, pet: "biblical" });
  let settingsText = $state("");
  let settingsObj = $state<unknown>(null);
  let settingsMode = $state<"form" | "raw">("form");
  let md = $state("");
  let status = $state<Record<string, { ok: boolean; msg: string } | null>>({});

  // Which harness the settings + instructions cards are showing.
  let harness = $state<HarnessId>("claude");
  const meta = $derived(app.harnesses.find(h => h.id === harness) ?? app.harnesses[0]);
  const isJson = $derived(meta.settingsFormat === "json");

  let codexMode = $state<CodexMode | null>(null);
  let codexModeBusy = $state(false);

  onMount(() => { loadHarness(); loadAppConfig(); });

  async function loadAppConfig() {
    try { cfg = await api.appConfig(); } catch { /* defaults stay */ }
  }

  async function loadHarness() {
    const requested = harness; // a slow response must not land under another harness
    const [s, m] = await Promise.allSettled([api.settingsText(requested), api.md(requested)]);
    if (requested !== harness) return;
    settingsText = s.status === "fulfilled" ? s.value : "";
    md = m.status === "fulfilled" ? m.value : "";
    settingsObj = null;
    settingsMode = "raw";
    if (isJson) {
      try { settingsObj = JSON.parse(settingsText); settingsMode = "form"; } catch { /* raw */ }
    }
    if (requested === "codex") {
      codexMode = app.usage?.codex?.mode ?? null;
      // usage polling is dash-only now: a cold load straight into /config has
      // no usage snapshot yet, so fetch one to seed the auth-mode toggle
      if (codexMode === null) {
        refreshUsage().then(() => {
          if (harness === "codex" && codexMode === null) codexMode = app.usage?.codex?.mode ?? null;
        });
      }
    }
  }

  function setHarness(id: HarnessId) {
    if (id === harness) return;
    harness = id;
    loadHarness();
  }

  function setSettingsMode(mode: "form" | "raw") {
    if (mode === settingsMode || !isJson) return;
    if (mode === "raw") {
      if (settingsObj !== null) settingsText = JSON.stringify(settingsObj, null, 2) + "\n";
    } else {
      try { settingsObj = JSON.parse(settingsText); }
      catch { flash("settings", false, "invalid JSON — fix it before switching to form"); return; }
    }
    settingsMode = mode;
  }

  function flash(key: string, ok: boolean, msg: string) {
    status[key] = { ok, msg };
    setTimeout(() => status[key] = null, 3500);
  }

  async function saveGreeting() {
    try {
      cfg = await api.saveAppConfig(cfg);
      flash("greeting", true, "saved");
      refreshGreeting();
    } catch (e) { flash("greeting", false, String(e)); }
  }

  async function saveSettings() {
    if (isJson) {
      if (settingsMode === "form") {
        settingsText = JSON.stringify(settingsObj, null, 2) + "\n";
      } else {
        try { JSON.parse(settingsText); }
        catch { flash("settings", false, "invalid JSON — not saved"); return; }
      }
    }
    try {
      await api.saveSettingsText(harness, settingsText);
      flash("settings", true, "saved — applies to new sessions");
      if (harness === "codex") refreshUsage(); // edits may flip the auth mode
    } catch (e) { flash("settings", false, String(e)); }
  }

  async function saveMd() {
    try {
      await api.saveMd(harness, md);
      flash("md", true, "saved — applies to new sessions");
    } catch (e) { flash("md", false, String(e)); }
  }

  /** Pet choice applies immediately (favicon, rail logo, mascot) and
      persists on its own — no Save button to remember. */
  async function pickPet(id: PetId) {
    if (cfg.pet === id) return;
    cfg.pet = id;
    applyPet(id);
    try { cfg = await api.saveAppConfig(cfg); flash("pet", true, "saved"); }
    catch (e) { flash("pet", false, String(e)); }
  }

  /** The Codex "options" the form mode renders: API key vs ChatGPT OAuth,
      applied by (un)commenting model_provider in config.toml. */
  async function setCodexMode(mode: CodexMode) {
    if (codexModeBusy || codexMode === mode) return;
    codexModeBusy = true;
    try {
      const res = await api.setCodexMode(mode);
      codexMode = res.mode;
      settingsText = res.configText;
      if (app.usage?.codex) app.usage.codex.mode = res.mode;
      flash("settings", true, `auth mode → ${mode === "api" ? "API key" : "ChatGPT OAuth"}`);
    } catch (e) { flash("settings", false, String(e)); }
    finally { codexModeBusy = false; }
  }
</script>

<div class="greet-row">
  <div class="greet"><h1>Config</h1></div>
  <div class="head-side">
    <div class="je-modes">
      {#each app.harnesses as h (h.id)}
        <button class="je-mode" class:on={h.id === harness} onclick={() => setHarness(h.id)}>{h.label}</button>
      {/each}
    </div>
  </div>
</div>

<div class="cfg-grid">
  <div class="glass glow cfg-card">
    <h3>Greeting</h3>
    <div class="cfg-row">
      <label for="cfg-name">Display name</label>
      <input id="cfg-name" type="text" bind:value={cfg.displayName} placeholder="Fenn" />
    </div>
    <div class="cfg-row">
      <label for="cfg-zip">Zip code (for weather)</label>
      <input id="cfg-zip" type="text" bind:value={cfg.zip} placeholder="97201" />
    </div>
    <label class="cfg-check">
      <input type="checkbox" bind:checked={cfg.greetingEnabled} />
      Whimsical greeting line (generated by Haiku, refreshed hourly)
    </label>
    <div class="cfg-row">
      <label for="cfg-renew">Plan renewal day (1–31, from claude.ai billing)</label>
      <input id="cfg-renew" type="text" inputmode="numeric"
        value={cfg.renewalDay ?? ""}
        oninput={(e) => {
          const n = parseInt(e.currentTarget.value, 10);
          cfg.renewalDay = n >= 1 && n <= 31 ? n : null;
        }}
        placeholder="e.g. 10 — drives the renews date + billing-cycle token count" />
    </div>
    <button class="btn" onclick={saveGreeting}>Save</button>
    {#if status.greeting}<span class="cfg-status" class:ok={status.greeting.ok} class:bad={!status.greeting.ok}>{status.greeting.msg}</span>{/if}
  </div>

  <div class="glass glow cfg-card">
    <h3>Pet</h3>
    <div class="pet-pick">
      {#each Object.values(PETS) as p (p.id)}
        <button class="pet-opt" class:on={cfg.pet === p.id} onclick={() => pickPet(p.id)}>
          <span class="pet-preview" style={p.ink ? `color:${p.ink}` : ""}>
            {#if p.lines}
              {#each p.lines as line}<span>{line}</span>{/each}
            {:else}
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round">
                <circle cx="12" cy="12" r="8.6"/>
                <ellipse cx="12" cy="12" rx="8.6" ry="3.4"/>
                <ellipse cx="12" cy="12" rx="3.4" ry="8.6"/>
                <circle cx="12" cy="12" r="0.7" fill="currentColor" stroke="none"/>
              </svg>
            {/if}
          </span>
          <span class="pet-name">{p.label}</span>
        </button>
      {/each}
    </div>
    <span class="pet-hint">picks the site icon, favicon, and the little traveler under the terminal</span>
    {#if status.pet}<span class="cfg-status" class:ok={status.pet.ok} class:bad={!status.pet.ok}>{status.pet.msg}</span>{/if}
  </div>

  <div class="glass glow cfg-card">
    <div class="cfg-head">
      <h3>{meta.settingsLabel}</h3>
      {#if isJson}
        <div class="je-modes">
          <button class="je-mode" class:on={settingsMode === "form"} onclick={() => setSettingsMode("form")}>Form</button>
          <button class="je-mode" class:on={settingsMode === "raw"} onclick={() => setSettingsMode("raw")}>Raw</button>
        </div>
      {/if}
    </div>
    {#if harness === "codex"}
      <div class="cfg-row cx-auth">
        <label for="cx-auth-modes">Model provider auth</label>
        <div id="cx-auth-modes" class="je-modes" class:busy={codexModeBusy}>
          <button class="je-mode" class:on={codexMode === "oauth"} disabled={codexModeBusy}
            onclick={() => setCodexMode("oauth")}>ChatGPT OAuth</button>
          <button class="je-mode" class:on={codexMode === "api"} disabled={codexModeBusy}
            onclick={() => setCodexMode("api")}>API key</button>
        </div>
        <span class="cx-auth-hint">comments/uncomments <span class="mono">model_provider</span> below</span>
      </div>
    {/if}
    {#if isJson && settingsMode === "form" && settingsObj !== null}
      <div class="je">
        <JsonNode value={settingsObj} update={(v) => (settingsObj = v)} />
      </div>
    {:else}
      <textarea class="cfg-editor" bind:value={settingsText} spellcheck="false"></textarea>
    {/if}
    <button class="btn" onclick={saveSettings}>Save settings</button>
    {#if status.settings}<span class="cfg-status" class:ok={status.settings.ok} class:bad={!status.settings.ok}>{status.settings.msg}</span>{/if}
  </div>

  <div class="glass glow cfg-card cfg-full">
    <h3>{meta.mdLabel}</h3>
    <textarea class="cfg-editor" style="min-height:380px" bind:value={md} spellcheck="false"></textarea>
    <button class="btn" onclick={saveMd}>Save {meta.mdLabel.split("/").pop()}</button>
    {#if status.md}<span class="cfg-status" class:ok={status.md.ok} class:bad={!status.md.ok}>{status.md.msg}</span>{/if}
  </div>
</div>

<style>
  .pet-pick{display:flex;gap:8px;margin-top:10px}
  .pet-opt{
    flex:1;display:flex;flex-direction:column;align-items:center;gap:7px;
    padding:12px 6px 9px;cursor:pointer;border-radius:12px;
    border:1px solid var(--glass-brd);background:transparent;color:var(--ink-dim);
    font:inherit;transition:border-color .15s,box-shadow .15s;
  }
  .pet-opt:hover{border-color:var(--glass-brd-lit)}
  .pet-opt.on{
    border-color:rgba(var(--accent-rgb),.55);
    box-shadow:0 0 16px -6px rgba(var(--accent-rgb),.6);
    color:var(--ink);
  }
  .pet-preview{
    display:flex;flex-direction:column;align-items:center;justify-content:center;
    height:44px;white-space:pre;
    font:600 10.5px/1.2 ui-monospace,SFMono-Regular,Menlo,monospace;
  }
  .pet-preview svg{width:36px;height:36px}
  .pet-name{font-size:11px;font-weight:600;letter-spacing:.03em}
  .pet-hint{display:block;font-size:10.5px;color:var(--ink-faint);margin-top:8px}
  .cx-auth{margin-top:10px}
  .cx-auth .je-modes.busy{opacity:.55;pointer-events:none}
  .cx-auth-hint{display:block;font-size:10.5px;color:var(--ink-faint);margin-top:5px}
</style>

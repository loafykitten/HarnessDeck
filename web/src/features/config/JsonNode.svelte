<script lang="ts">
  import Self from "./JsonNode.svelte";

  interface Props {
    value: unknown;
    path?: string;
    update: (v: unknown) => void;
  }
  let { value, path = "", update }: Props = $props();

  // Known enum values for ~/.claude/settings.json keys, matched by key name.
  const ENUMS: Record<string, string[]> = {
    defaultMode: ["default", "acceptEdits", "plan", "bypassPermissions"],
    effortLevel: ["low", "medium", "high"],
    theme: ["dark", "light", "dark-daltonized", "light-daltonized", "dark-ansi", "light-ansi"],
  };

  const leaf = $derived(path.split(".").pop() ?? "");
  const enumOpts = $derived(
    typeof value === "string" && ENUMS[leaf]
      ? [...new Set([...ENUMS[leaf], value])]
      : null,
  );

  let editing = $state(false);
  let draft = $state("");
  let collapsed = $state(false);

  function startEdit() {
    draft = typeof value === "string" ? value : JSON.stringify(value);
    editing = true;
  }
  function commit() {
    if (!editing) return;
    editing = false;
    if (typeof value === "number") {
      const n = Number(draft);
      update(Number.isFinite(n) && draft.trim() !== "" ? n : value);
      return;
    }
    if (typeof value === "string") { update(draft); return; }
    // null or other: accept JSON if valid, else keep as string
    try { update(JSON.parse(draft)); } catch { update(draft); }
  }
  function autofocus(el: HTMLInputElement) { el.focus(); el.select(); }

  // add-entry state for arrays & objects
  let newKey = $state("");
  let newType = $state("string");
  const BLANK: Record<string, unknown> = { string: "", number: 0, boolean: false, object: {}, array: [] };
  const blank = () => structuredClone(BLANK[newType]);

  function arrSet(i: number, v: unknown) { const a = [...(value as unknown[])]; a[i] = v; update(a); }
  function arrDel(i: number) { const a = [...(value as unknown[])]; a.splice(i, 1); update(a); }
  function arrAdd() { update([...(value as unknown[]), blank()]); }

  function objSet(k: string, v: unknown) { update({ ...(value as object), [k]: v }); }
  function objDel(k: string) { const o = { ...(value as Record<string, unknown>) }; delete o[k]; update(o); }
  function objAdd() {
    const k = newKey.trim();
    if (!k || (value as Record<string, unknown>)[k] !== undefined) return;
    update({ ...(value as object), [k]: blank() });
    newKey = "";
  }
</script>

{#if typeof value === "boolean"}
  <label class="je-bool">
    <input type="checkbox" checked={value} onchange={(e) => update(e.currentTarget.checked)} />
    <span class="je-lit">{value}</span>
  </label>
{:else if enumOpts}
  <select class="je-select" value={value} onchange={(e) => update(e.currentTarget.value)}>
    {#each enumOpts as o (o)}<option value={o}>{o}</option>{/each}
  </select>
{:else if Array.isArray(value)}
  <div class="je-wrap">
    <button class="je-fold" title={collapsed ? "Expand" : "Collapse"}
      onclick={() => (collapsed = !collapsed)}>{collapsed ? "▸" : "▾"}</button>
    {#if collapsed}
      <button class="je-summary" onclick={() => (collapsed = false)}>
        [{value.length}] {value.length === 1 ? "item" : "items"}
      </button>
    {:else}
  <div class="je-block">
    {#each value as item, i (i)}
      <div class="je-row">
        <Self value={item} {path} update={(v) => arrSet(i, v)} />
        <button class="je-x" title="Remove item" onclick={() => arrDel(i)}>×</button>
      </div>
    {/each}
    <div class="je-add">
      <select class="je-select" bind:value={newType}>
        {#each Object.keys(BLANK) as t (t)}<option value={t}>{t}</option>{/each}
      </select>
      <button class="je-plus" onclick={arrAdd}>+ add item</button>
    </div>
  </div>
    {/if}
  </div>
{:else if typeof value === "object" && value !== null}
  <div class="je-wrap">
    <button class="je-fold" title={collapsed ? "Expand" : "Collapse"}
      onclick={() => (collapsed = !collapsed)}>{collapsed ? "▸" : "▾"}</button>
    {#if collapsed}
      <button class="je-summary" onclick={() => (collapsed = false)}>
        {"{"}{Object.keys(value).length}{"}"} {Object.keys(value).length === 1 ? "key" : "keys"}
      </button>
    {:else}
  <div class="je-block">
    {#each Object.entries(value) as [k, v] (k)}
      <div class="je-row">
        <span class="je-key">{k}</span>
        <Self value={v} path={path ? `${path}.${k}` : k} update={(nv) => objSet(k, nv)} />
        <button class="je-x" title="Remove key" onclick={() => objDel(k)}>×</button>
      </div>
    {/each}
    <div class="je-add">
      <input class="je-input je-newkey" placeholder="key" bind:value={newKey}
        onkeydown={(e) => { if (e.key === "Enter") objAdd(); }} />
      <select class="je-select" bind:value={newType}>
        {#each Object.keys(BLANK) as t (t)}<option value={t}>{t}</option>{/each}
      </select>
      <button class="je-plus" onclick={objAdd} disabled={!newKey.trim()}>+ add key</button>
    </div>
  </div>
    {/if}
  </div>
{:else if editing}
  <input class="je-input" use:autofocus bind:value={draft} onblur={commit}
    onkeydown={(e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") editing = false; }} />
{:else}
  <button class="je-val" class:str={typeof value === "string"} class:num={typeof value === "number"}
    title="Click to edit" onclick={startEdit}>
    {value === null ? "null" : typeof value === "string" ? (value === "" ? "(empty)" : value) : String(value)}
  </button>
{/if}

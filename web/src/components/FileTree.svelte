<script lang="ts">
  import { onMount } from "svelte";
  import { api, type ProjectTree, type TreeNode } from "../lib/api";
  import FileTreeNode from "./FileTreeNode.svelte";

  let { project }: { project: string } = $props();

  let tree = $state<ProjectTree | null>(null);
  let loading = $state(true);
  let error = $state("");
  let filter = $state("");
  let dirsOnly = $state(false);
  let showHidden = $state(false);
  let request = 0;

  async function load(fresh = false) {
    const current = ++request;
    loading = true;
    error = "";
    try {
      const next = await api.projectTree(project, fresh);
      if (current === request) tree = next;
    } catch (e) {
      if (current === request) error = e instanceof Error ? e.message : "Could not load files";
    } finally {
      if (current === request) loading = false;
    }
  }

  export async function refresh() {
    await load(true);
  }

  onMount(() => load());

  function visibleByHidden(node: TreeNode): TreeNode | null {
    if (node.hidden && !showHidden) return null;
    if (node.kind === "file") return node;
    const children = (node.children ?? [])
      .map(visibleByHidden)
      .filter((child): child is TreeNode => child !== null);
    return { ...node, children };
  }

  function matchingNode(node: TreeNode, query: string): TreeNode | null {
    if (node.hidden && !showHidden) return null;
    if (node.kind === "file") {
      const extQuery = query.startsWith(".") ? query.slice(1) : query;
      return !query || node.name.toLowerCase().includes(query) || node.ext === extQuery ? node : null;
    }
    if (query && node.name.toLowerCase().includes(query)) return visibleByHidden(node);
    const children = (node.children ?? [])
      .map(child => matchingNode(child, query))
      .filter((child): child is TreeNode => child !== null);
    if (query && children.length === 0) return null;
    return { ...node, children };
  }

  function withoutFiles(node: TreeNode): TreeNode {
    return {
      ...node,
      children: (node.children ?? []).filter(child => child.kind === "dir").map(withoutFiles),
    };
  }

  const query = $derived(filter.trim().toLowerCase());
  const visible = $derived.by(() => {
    if (!tree) return [];
    let nodes = (tree.root.children ?? [])
      .map(node => matchingNode(node, query))
      .filter((node): node is TreeNode => node !== null);
    if (dirsOnly) nodes = nodes.filter(node => node.kind === "dir").map(withoutFiles);
    return nodes;
  });
</script>

<div class="ft-tools">
  <input class="mono" aria-label="Filter files by type or name" placeholder="Filter type or name…" bind:value={filter} />
  <button class:on={dirsOnly} aria-pressed={dirsOnly} title="Show directories only"
    onclick={() => dirsOnly = !dirsOnly}>Dirs</button>
  <button class:on={showHidden} aria-pressed={showHidden} title="Show hidden files"
    onclick={() => showHidden = !showHidden}>Hidden</button>
</div>

{#if tree?.git}
  <div class="ft-legend" aria-label="Git status colors">
    <span><i class="tracked"></i>tracked</span>
    <span><i class="untracked"></i>untracked</span>
    <span><i class="ignored"></i>ignored</span>
  </div>
{/if}

<div class="ft-scroll">
  {#if loading && !tree}
    <div class="ft-state">Loading files…</div>
  {:else if error}
    <div class="ft-state error">{error}</div>
  {:else if visible.length === 0}
    <div class="ft-state">{query ? "No matching files" : "No files to show"}</div>
  {:else}
    {#each visible as node (node.path)}
      <FileTreeNode {node} filterActive={query.length > 0} />
    {/each}
  {/if}
</div>

{#if tree?.truncated}
  <div class="ft-note">Tree truncated to keep it responsive.</div>
{/if}

<style>
  .ft-tools{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:5px;padding:10px 10px 8px}
  .ft-tools input{min-width:0;width:100%;font-size:11px;color:var(--ink);outline:0;padding:7px 8px;
    border-radius:8px;border:1px solid var(--glass-brd);background:var(--glass)}
  .ft-tools input::placeholder{color:var(--ink-faint)}
  .ft-tools input:focus{border-color:var(--glass-brd-lit);box-shadow:0 0 16px -8px var(--accent)}
  .ft-tools button{font-size:10px;color:var(--ink-faint);padding:6px;border-radius:8px;
    border:1px solid var(--glass-brd);background:var(--glass)}
  .ft-tools button:hover{color:var(--ink-dim);border-color:var(--glass-brd-lit)}
  .ft-tools button.on{color:var(--accent-2);border-color:var(--accent-2);background:var(--glass-2)}
  .ft-legend{display:flex;gap:10px;padding:0 12px 8px;color:var(--ink-faint);font-size:9.5px;
    border-bottom:1px solid var(--glass-brd)}
  .ft-legend span{display:flex;align-items:center;gap:4px}
  .ft-legend i{display:block;width:5px;height:5px;border-radius:50%}
  .ft-legend .tracked{background:var(--ok)}
  .ft-legend .untracked{background:var(--accent-2)}
  .ft-legend .ignored{background:var(--ink-faint)}
  .ft-scroll{max-height:min(64vh,670px);overflow:auto;padding:7px 5px 9px;scrollbar-width:thin}
  .ft-state{padding:28px 12px;text-align:center;font-size:11.5px;color:var(--ink-faint)}
  .ft-state.error{color:var(--bad)}
  .ft-note{padding:7px 11px;border-top:1px solid var(--glass-brd);font-size:9.5px;color:var(--ink-faint)}
</style>

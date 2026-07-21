<script lang="ts">
  import type { TreeNode } from "../../types/api";
  import Self from "./FileTreeNode.svelte";

  interface Props {
    node: TreeNode;
    depth?: number;
    filterActive?: boolean;
  }
  let { node, depth = 0, filterActive = false }: Props = $props();

  let collapsed = $state<boolean | null>(null);
  const folded = $derived(filterActive ? false : (collapsed ?? depth > 0));
</script>

{#if node.kind === "dir"}
  <button class="ft-row dir" style={`--depth:${depth}`} title={node.path}
    aria-expanded={!folded} onclick={() => collapsed = !folded}>
    <span class="ft-fold" aria-hidden="true">{folded ? "▸" : "▾"}</span>
    <svg class="ft-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
    {#if node.git !== "none"}<span class="ft-dot git-{node.git}" aria-hidden="true"></span>{/if}
    <span class="ft-name mono git-{node.git}">{node.name}</span>
  </button>
  {#if !folded && node.children?.length}
    {#each node.children as child (child.path)}
      <Self node={child} depth={depth + 1} {filterActive} />
    {/each}
  {/if}
{:else}
  <div class="ft-row file" style={`--depth:${depth}`} title={node.path}>
    <span class="ft-fold" aria-hidden="true"></span>
    <svg class="ft-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M6 3h8l4 4v14H6z" />
      <path d="M14 3v5h5" />
    </svg>
    {#if node.git !== "none"}<span class="ft-dot git-{node.git}" aria-hidden="true"></span>{/if}
    <span class="ft-name mono git-{node.git}">{node.name}</span>
  </div>
{/if}

<style>
  .ft-row{width:100%;min-width:0;height:27px;padding:0 8px 0 calc(8px + var(--depth) * 13px);
    display:flex;align-items:center;gap:5px;border-radius:7px;color:var(--ink);text-align:left}
  button.ft-row:hover{background:var(--glass-2)}
  .ft-fold{width:11px;flex:none;color:var(--ink-faint);font-size:10px;text-align:center}
  .ft-icon{width:14px;height:14px;flex:none;fill:none;stroke:var(--ink-dim);stroke-width:1.6;
    stroke-linejoin:round;stroke-linecap:round}
  .dir .ft-icon{fill:var(--glass-2)}
  .ft-dot{width:5px;height:5px;border-radius:50%;flex:none;background:var(--ink)}
  .ft-dot.git-tracked{background:var(--ok);box-shadow:0 0 7px var(--ok)}
  .ft-dot.git-untracked{background:var(--accent-2);box-shadow:0 0 7px var(--accent-2)}
  .ft-dot.git-ignored{background:var(--ink-faint)}
  .ft-name{font-size:11.5px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:var(--ink)}
  .ft-name.git-tracked{color:var(--ok)}
  .ft-name.git-untracked{color:var(--accent-2)}
  .ft-name.git-ignored{color:var(--ink-faint)}
</style>

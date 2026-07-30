<script lang="ts">
  import { tick } from "svelte";
  import type { ChatFeedItem, ChatHarness } from "../../../types/chat";
  import AgentBar from "./AgentBar.svelte";
  import AgentView from "./AgentView.svelte";
  import FeedEntry from "./FeedEntry.svelte";
  import SubagentCard from "./SubagentCard.svelte";

  let { feed, permission, question, harness = "claude", viewing = $bindable(null) }: {
    feed: ChatFeedItem[];
    permission: (id: string, behavior: "allow" | "deny", always?: boolean, message?: string) => void;
    question: (id: string, answers: Record<string, string[]>) => void;
    harness?: ChatHarness;
    /** Id of the subagent group being viewed; bindable so the pane can hide the composer. */
    viewing?: string | null;
  } = $props();
  const agentLabel = $derived(harness === "codex" ? "Codex" : "Claude");
  let host: HTMLDivElement;
  let pinned = $state(true);

  type ToolItem = Extract<ChatFeedItem, { type: "tool" }>;
  type RenderItem = { type: "item"; item: ChatFeedItem } | {
    type: "group"; id: string; items: ChatFeedItem[]; running: boolean; task?: ToolItem;
  };

  /** Tools that spawn a subagent; their input carries the task (description/prompt). */
  const AGENT_TOOLS = /^(Task|Agent)$/i;

  function grouped(items: ChatFeedItem[]): RenderItem[] {
    // A subagent's activity references its spawning tool call via parentToolUseId.
    // Pre-collect those ids so the spawning call itself can be folded into the
    // group as its header, instead of rendering as a disconnected tool row.
    const parents = new Set<string>();
    for (const item of items) {
      if ("parentToolUseId" in item && item.parentToolUseId) parents.add(item.parentToolUseId);
    }
    const output: RenderItem[] = [];
    const groups = new Map<string, Extract<RenderItem, { type: "group" }>>();
    const ensure = (id: string) => {
      let group = groups.get(id);
      if (!group) {
        group = { type: "group" as const, id, items: [], running: false };
        groups.set(id, group);
        output.push(group);
      }
      return group;
    };
    for (const item of items) {
      const parent = "parentToolUseId" in item ? item.parentToolUseId : undefined;
      if (!parent && item.type === "tool" && (AGENT_TOOLS.test(item.name) || parents.has(item.toolId))) {
        const group = ensure(item.toolId);
        group.task = item;
        group.running ||= item.running;
        continue;
      }
      if (!parent) {
        output.push({ type: "item", item });
        continue;
      }
      const group = ensure(parent);
      group.items.push(item);
      group.running ||= (item.type === "tool" && item.running)
        || ((item.type === "message" || item.type === "thinking") && !!item.streaming);
    }
    return output;
  }

  const items = $derived(grouped(feed));

  // Drill-in: a subagent row swaps the feed for that agent's read-only view.
  const viewingGroup = $derived(viewing === null
    ? null
    : items.find((entry): entry is Extract<RenderItem, { type: "group" }> =>
      entry.type === "group" && entry.id === viewing) ?? null);

  function enterAgent(group: Extract<RenderItem, { type: "group" }>): void {
    viewing = group.id;
    // Follow a live agent from the bottom; read a finished one from the top.
    pinned = group.running;
    tick().then(() => host?.scrollTo({ top: group.running ? host.scrollHeight : 0 }));
  }

  function leaveAgent(): void {
    viewing = null;
    pinned = true;
    tick().then(() => host?.scrollTo({ top: host.scrollHeight }));
  }

  $effect(() => {
    feed.length;
    if (pinned) tick().then(() => host?.scrollTo({ top: host.scrollHeight, behavior: "smooth" }));
  });
</script>

<div class="chat-body">
  {#if viewingGroup}
    <AgentBar group={viewingGroup} back={leaveAgent} />
  {/if}
  <div class="chat-feed" bind:this={host}
    onscroll={() => pinned = host.scrollHeight - host.scrollTop - host.clientHeight < 80}>
    {#if viewingGroup}
      <AgentView group={viewingGroup} {permission} {question} />
    {:else}
      {#if feed.length === 0}
        <div class="chat-welcome"><b>Start a conversation</b><span>Send a message to put a {agentLabel} agent to work in this project.</span></div>
      {/if}
      {#each items as entry (entry.type === "item" ? entry.item.id : entry.id)}
        {#if entry.type === "item"}
          <FeedEntry item={entry.item} {permission} {question} {agentLabel} />
        {:else}
          <SubagentCard group={entry} open={() => enterAgent(entry)} />
        {/if}
      {/each}
    {/if}
  </div>
</div>

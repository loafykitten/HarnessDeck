<script lang="ts">
  import { tick } from "svelte";
  import type { ChatFeedItem, ChatHarness } from "../../../types/chat";
  import FeedEntry from "./FeedEntry.svelte";
  import SubagentCard from "./SubagentCard.svelte";

  let { feed, permission, question, harness = "claude" }: {
    feed: ChatFeedItem[];
    permission: (id: string, behavior: "allow" | "deny", always?: boolean, message?: string) => void;
    question: (id: string, answers: Record<string, string[]>) => void;
    harness?: ChatHarness;
  } = $props();
  const agentLabel = $derived(harness === "codex" ? "Codex" : "Claude");
  let host: HTMLDivElement;
  let pinned = $state(true);

  type RenderItem = { type: "item"; item: ChatFeedItem } | {
    type: "group"; id: string; items: ChatFeedItem[]; running: boolean;
  };

  function grouped(items: ChatFeedItem[]): RenderItem[] {
    const output: RenderItem[] = [];
    const groups = new Map<string, Extract<RenderItem, { type: "group" }>>();
    for (const item of items) {
      if (!("parentToolUseId" in item) || !item.parentToolUseId) {
        output.push({ type: "item", item });
        continue;
      }
      let group = groups.get(item.parentToolUseId);
      if (!group) {
        group = { type: "group", id: item.parentToolUseId, items: [], running: false };
        groups.set(item.parentToolUseId, group);
        output.push(group);
      }
      group.items.push(item);
      group.running ||= (item.type === "tool" && item.running) || (item.type === "message" && !!item.streaming);
    }
    return output;
  }

  const items = $derived(grouped(feed));

  $effect(() => {
    feed.length;
    if (pinned) tick().then(() => host?.scrollTo({ top: host.scrollHeight, behavior: "smooth" }));
  });
</script>

<div class="chat-feed" bind:this={host}
  onscroll={() => pinned = host.scrollHeight - host.scrollTop - host.clientHeight < 80}>
  {#if feed.length === 0}
    <div class="chat-welcome"><b>Start a conversation</b><span>Send a message to put a {agentLabel} agent to work in this project.</span></div>
  {/if}
  {#each items as entry (entry.type === "item" ? entry.item.id : entry.id)}
    {#if entry.type === "item"}
      <FeedEntry item={entry.item} {permission} {question} {agentLabel} />
    {:else}
      <SubagentCard group={entry} {permission} {question} />
    {/if}
  {/each}
</div>

<script lang="ts">
  import { untrack } from "svelte";
  import type { ChatFeedItem } from "../../../types/chat";
  import FeedEntry from "./FeedEntry.svelte";

  let { group, permission, question }: {
    group: { id: string; items: ChatFeedItem[]; running: boolean };
    permission: (id: string, behavior: "allow" | "deny", always?: boolean, message?: string) => void;
    question: (id: string, answers: Record<string, string[]>) => void;
  } = $props();
  let open = $state(untrack(() => group.running));
</script>

<details class="subagent-card" bind:open>
  <summary><span class:working={group.running}></span>subagent · {group.running ? "running" : "done"}</summary>
  <div class="subagent-feed">
    {#each group.items as item (item.id)}<FeedEntry {item} {permission} {question} />{/each}
  </div>
</details>

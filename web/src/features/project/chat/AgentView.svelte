<script lang="ts">
  import type { ChatFeedItem } from "../../../types/chat";
  import { asRecord, asString } from "../../../lib/tools";
  import FeedEntry from "./FeedEntry.svelte";
  import Markdown from "./Markdown.svelte";

  let { group, permission, question }: {
    group: {
      id: string;
      items: ChatFeedItem[];
      running: boolean;
      task?: Extract<ChatFeedItem, { type: "tool" }>;
    };
    permission: (id: string, behavior: "allow" | "deny", always?: boolean, message?: string) => void;
    question: (id: string, answers: Record<string, string[]>) => void;
  } = $props();

  const input = $derived(asRecord(group.task?.input));
  const agentType = $derived(asString(input?.subagent_type) ?? "agent");
  const prompt = $derived(asString(input?.prompt));
  const failed = $derived(!group.running && group.task?.isError === true);
  // The agent's forwarded messages already end with its report; only fall back
  // to the tool result when the inner feed is missing (rehydrated history
  // drops sidechains) or the run errored out.
  const report = $derived.by(() => {
    const task = group.task;
    if (!task || task.running || typeof task.result !== "string" || !task.result) return null;
    return task.isError || group.items.length === 0 ? task.result : null;
  });
</script>

{#if prompt}
  <details class="agent-task">
    <summary>task</summary>
    <pre>{prompt}</pre>
  </details>
{/if}

{#each group.items as item (item.id)}
  <FeedEntry {item} {permission} {question} agentLabel={agentType} />
{/each}

{#if report}
  <div class="agent-report" class:error={failed}>
    {#if failed}<pre>{report}</pre>{:else}<Markdown text={report} />{/if}
  </div>
{/if}

{#if !group.items.length && !report}
  <div class="agent-empty">{group.running ? "Working — nothing reported yet…" : "No recorded activity for this agent."}</div>
{/if}

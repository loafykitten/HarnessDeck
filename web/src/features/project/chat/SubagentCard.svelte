<script lang="ts">
  import type { ChatFeedItem } from "../../../types/chat";
  import { asRecord, asString } from "../../../lib/tools";

  let { group, open }: {
    group: {
      id: string;
      items: ChatFeedItem[];
      running: boolean;
      task?: Extract<ChatFeedItem, { type: "tool" }>;
    };
    open: () => void;
  } = $props();

  const input = $derived(asRecord(group.task?.input));
  const agentType = $derived(asString(input?.subagent_type) ?? "agent");
  const description = $derived(asString(input?.description) ?? "");
  const failed = $derived(!group.running && group.task?.isError === true);
</script>

<button class="subagent-row" class:failed onclick={open} title="View agent activity">
  <span class="agent-dot" class:working={group.running}></span>
  <span class="agent-glyph">✦</span>
  <b class="agent-type">{agentType}</b>
  {#if description}<span class="agent-desc">{description}</span>{/if}
  <span class="agent-state">{group.running ? "working" : failed ? "failed" : "done"}</span>
  <span class="agent-enter">›</span>
</button>

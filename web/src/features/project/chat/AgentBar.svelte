<script lang="ts">
  import type { ChatFeedItem } from "../../../types/chat";
  import { asRecord, asString } from "../../../lib/tools";

  let { group, back }: {
    group: {
      id: string;
      items: ChatFeedItem[];
      running: boolean;
      task?: Extract<ChatFeedItem, { type: "tool" }>;
    };
    back: () => void;
  } = $props();

  const input = $derived(asRecord(group.task?.input));
  const agentType = $derived(asString(input?.subagent_type) ?? "agent");
  const description = $derived(asString(input?.description) ?? "");
  const model = $derived(asString(input?.model));
  const failed = $derived(!group.running && group.task?.isError === true);
</script>

<div class="agent-view-bar" class:failed>
  <button class="agent-back" onclick={back}>‹ back</button>
  <span class="agent-glyph">✦</span>
  <b class="agent-type">{agentType}</b>
  {#if description}<span class="agent-desc">{description}</span>{/if}
  {#if model}<span class="agent-model">{model}</span>{/if}
  <span class="agent-state">
    <span class="agent-dot" class:working={group.running}></span>
    {group.running ? "working" : failed ? "failed" : "done"}
  </span>
</div>

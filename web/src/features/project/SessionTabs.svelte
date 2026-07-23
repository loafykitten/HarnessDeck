<script lang="ts">
  import type { Snippet } from "svelte";
  import type { HarnessId, SessionStatus } from "../../types/api";
  import { fmtAgo } from "../../utils/format";

  type SessionTab = {
    id: string;
    name: string;
    harness: HarnessId;
    status: SessionStatus;
    activity: number;
    closeLabel: string;
  };

  let {
    sessions,
    activeId,
    onSelect,
    onClose,
    children,
  }: {
    sessions: SessionTab[];
    activeId: string | null;
    onSelect: (id: string) => void;
    onClose: (session: SessionTab) => void;
    children?: Snippet;
  } = $props();

  const STATUS_LABEL = { working: "working", waiting: "needs you", idle: "idle" } as const;
</script>

<div class="tabs" role="tablist" aria-orientation="vertical">
  {#each sessions as session (session.id)}
    <div class="tab" class:active={session.id === activeId}
      role="tab" tabindex="0" aria-selected={session.id === activeId}
      onclick={() => onSelect(session.id)}
      onkeydown={(event) => event.key === "Enter" && onSelect(session.id)}>
      {#if session.id === activeId}<span class="tab-nub" aria-hidden="true"><i></i></span>{/if}
      <span class="tdot {session.status}"></span>
      <span class="tab-info">
        <span class="tab-name">{session.name}</span>
        <span class="tab-meta"><span class="hx {session.harness}">{session.harness}</span> <span class="st {session.status}">{STATUS_LABEL[session.status]}</span></span>
        <span class="tab-time">{fmtAgo(session.activity)}</span>
      </span>
      <span class="tab-x" role="button" tabindex="0" aria-label={session.closeLabel}
        onclick={(event) => { event.stopPropagation(); onClose(session); }}
        onkeydown={(event) => event.key === "Enter" && (event.stopPropagation(), onClose(session))}>✕</span>
    </div>
  {/each}
  {@render children?.()}
</div>

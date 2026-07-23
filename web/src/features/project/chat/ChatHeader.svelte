<script lang="ts">
  import { app } from "../../../stores/state.svelte";
  import type { ChatSession } from "../../../types/chat";

  let { session, branch, connected, reconnecting }: {
    session: ChatSession | null;
    branch?: string;
    connected: boolean;
    reconnecting: boolean;
  } = $props();
  const five = $derived(Math.max(0, Math.min(100, app.usage?.limits?.fiveHour?.pct ?? 0)));
  const week = $derived(Math.max(0, Math.min(100, app.usage?.limits?.weekly?.pct ?? 0)));
</script>

<header class="chat-header">
  <div class="chat-limits" title="Claude usage">
    <span>5h</span><i><b style:width={`${five}%`}></b></i><em>{app.usage?.limits?.fiveHour?.pct != null ? `${app.usage.limits.fiveHour.pct}%` : "–"}</em>
    <span>week</span><i><b style:width={`${week}%`}></b></i><em>{app.usage?.limits?.weekly?.pct != null ? `${app.usage.limits.weekly.pct}%` : "–"}</em>
  </div>
  <div class="chat-head-meta">
    {#if branch}<span class="pill mono">{branch}</span>{/if}
    <span class="pill">${(session?.costUsd ?? 0).toFixed(3)}</span>
    <span class="chat-connection" class:on={connected}>{reconnecting ? "reconnecting" : connected ? "live" : "offline"}</span>
  </div>
</header>

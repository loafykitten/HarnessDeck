<script lang="ts">
  import { app } from "../../../stores/state.svelte";
  import type { ChatSession } from "../../../types/chat";

  let { session, branch, connected, reconnecting }: {
    session: ChatSession | null;
    branch?: string;
    connected: boolean;
    reconnecting: boolean;
  } = $props();
  const limits = $derived(session?.harness === "codex" ? app.usage?.codex?.limits : app.usage?.limits);
  const five = $derived(Math.max(0, Math.min(100, limits?.fiveHour?.pct ?? 0)));
  const week = $derived(Math.max(0, Math.min(100, limits?.weekly?.pct ?? 0)));
</script>

<header class="chat-header">
  <div class="chat-limits" title={session?.harness === "codex" ? "Codex usage" : "Claude usage"}>
    <span>5h</span><i><b style:width={`${five}%`}></b></i><em>{limits?.fiveHour?.pct != null ? `${limits.fiveHour.pct}%` : "–"}</em>
    <span>week</span><i><b style:width={`${week}%`}></b></i><em>{limits?.weekly?.pct != null ? `${limits.weekly.pct}%` : "–"}</em>
  </div>
  <div class="chat-head-meta">
    {#if branch}<span class="pill mono">{branch}</span>{/if}
    {#if session?.harness !== "codex"}<span class="pill">${(session?.costUsd ?? 0).toFixed(3)}</span>{/if}
    <span class="chat-connection" class:on={connected}>{reconnecting ? "reconnecting" : connected ? "live" : "offline"}</span>
  </div>
</header>

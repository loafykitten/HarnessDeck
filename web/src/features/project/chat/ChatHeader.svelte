<script lang="ts">
  import { app } from "../../../stores/state.svelte";
  import type { ChatSession } from "../../../types/chat";
  import { fmtTokens } from "../../../utils/format";

  let { session, branch, connected, reconnecting }: {
    session: ChatSession | null;
    branch?: string;
    connected: boolean;
    reconnecting: boolean;
  } = $props();
  const limits = $derived(session?.harness === "codex" ? app.usage?.codex?.limits : app.usage?.limits);
  const five = $derived(Math.max(0, Math.min(100, limits?.fiveHour?.pct ?? 0)));
  const week = $derived(Math.max(0, Math.min(100, limits?.weekly?.pct ?? 0)));
  const fable = $derived(Math.max(0, Math.min(100, app.usage?.limits?.weeklyModel?.pct ?? 0)));
  // An isolated chat lives on its worktree branch, not the project's.
  const shownBranch = $derived(session?.worktree ? session.worktree.split("/").pop() : branch);
</script>

<header class="chat-header">
  <div class="chat-limits" class:fable={session?.harness === "claude" && !!app.usage?.limits?.weeklyModel}
    title={session?.harness === "codex" ? "Codex usage" : "Claude usage"}>
    <span>5h</span><i><b style:width={`${five}%`}></b></i><em>{limits?.fiveHour?.pct != null ? `${limits.fiveHour.pct}%` : "–"}</em>
    <span>week</span><i><b style:width={`${week}%`}></b></i><em>{limits?.weekly?.pct != null ? `${limits.weekly.pct}%` : "–"}</em>
    {#if session?.harness === "claude" && app.usage?.limits?.weeklyModel}
      <span>{app.usage.limits.weeklyModel.model}</span><i><b style:width={`${fable}%`}></b></i><em>{app.usage.limits.weeklyModel.pct}%</em>
    {/if}
  </div>
  <div class="chat-head-meta">
    {#if shownBranch}<span class="pill mono" title={session?.worktree ? `isolated worktree at ${session.worktree}` : undefined}>{shownBranch}</span>{/if}
    {#if session?.harness === "claude"}<span class="pill">{fmtTokens(session.totalTokens)} tokens</span>{/if}
    {#if session?.harness !== "codex"}<span class="pill">${(session?.costUsd ?? 0).toFixed(3)}</span>{/if}
    <span class="chat-connection" class:on={connected}>{reconnecting ? "reconnecting" : connected ? "live" : "offline"}</span>
  </div>
</header>

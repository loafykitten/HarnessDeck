<script lang="ts">
  import { onMount } from "svelte";
  import { api } from "../../../lib/api";
  import { disposeChatStore } from "../../../stores/chat.svelte";
  import type { ChatEffort, ChatModel, ChatPermissionMode, ChatSession } from "../../../types/chat";
  import { fmtAgo } from "../../../utils/format";
  import ChatPane from "./ChatPane.svelte";

  let { project, branch }: { project: string; branch?: string } = $props();
  let sessions = $state<ChatSession[]>([]);
  let activeId = $state<string | null>(null);
  let loading = $state(true);
  let creating = $state(false);
  let showForm = $state(false);
  let error = $state("");
  let name = $state("");
  let model = $state<ChatModel>("default");
  let effort = $state<ChatEffort>("high");
  let permissionMode = $state<ChatPermissionMode>("default");

  onMount(async () => {
    try {
      sessions = await api.chatSessions(project);
      activeId = sessions[0]?.id ?? null;
      showForm = sessions.length === 0;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not load chats";
    } finally { loading = false; }
  });

  async function create(): Promise<void> {
    creating = true;
    error = "";
    try {
      const session = await api.createChatSession({
        project,
        name: name.trim() || `chat-${sessions.length + 1}`,
        harness: "claude",
        model,
        effort,
        permissionMode,
      });
      sessions.push(session);
      activeId = session.id;
      name = "";
      showForm = false;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not create chat";
    } finally { creating = false; }
  }

  async function close(session: ChatSession): Promise<void> {
    if (!confirm(`Delete chat “${session.name}”? Its running agent will stop.`)) return;
    try {
      await api.deleteChatSession(session.id);
      disposeChatStore(session.id);
      sessions = sessions.filter(item => item.id !== session.id);
      if (activeId === session.id) activeId = sessions[0]?.id ?? null;
      if (sessions.length === 0) showForm = true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : "Could not delete chat";
    }
  }

  function updateSession(updated: ChatSession): void {
    const session = sessions.find(item => item.id === updated.id);
    if (session) Object.assign(session, updated);
  }
</script>

<div class="glass chat-shell">
  <div class="chat-tabs" role="tablist">
    {#each sessions as session (session.id)}
      <div class="chat-tab" class:active={session.id === activeId} role="tab" tabindex="0"
        aria-selected={session.id === activeId} onclick={() => activeId = session.id}
        onkeydown={(event) => event.key === "Enter" && (activeId = session.id)}>
        <span class="tdot {session.status}"></span>
        <span><b>{session.name}</b><small>{session.model} · {fmtAgo(session.lastActivity)}</small></span>
        <button aria-label={`Delete ${session.name}`} onclick={(event) => { event.stopPropagation(); close(session); }}>×</button>
      </div>
    {/each}
    <button class="chat-new" onclick={() => showForm = !showForm}>+ new chat</button>
  </div>

  {#if showForm}
    <form class="chat-new-form" onsubmit={(event) => { event.preventDefault(); create(); }}>
      <div class="form-title"><b>New agent chat</b><span>Chat with a Claude agent directly — separate from your tmux sessions</span></div>
      <label>Name<input placeholder={`chat-${sessions.length + 1}`} bind:value={name} /></label>
      <fieldset><legend>Agent</legend><div class="agent-pick"><button type="button" class="on"><span class="hx claude">Claude</span></button><button type="button" disabled><span class="hx codex">Codex</span><small>soon</small></button></div></fieldset>
      <label>Model<select bind:value={model}><option value="default">default</option><option value="fable">fable</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option></select></label>
      <label>Effort<select bind:value={effort}><option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option></select></label>
      <label>Mode<select bind:value={permissionMode}><option value="default">default</option><option value="plan">plan</option><option value="acceptEdits">accept edits</option><option value="bypassPermissions">skip approvals</option></select></label>
      <div class="form-actions"><button type="submit" class="btn" disabled={creating}>{creating ? "Starting…" : "Start chat"}</button>{#if sessions.length}<button type="button" class="btn ghost" onclick={() => showForm = false}>Cancel</button>{/if}</div>
    </form>
  {:else if loading}
    <div class="chat-loading">Loading chats…</div>
  {:else}
    {#each sessions as session (session.id)}
      <ChatPane sessionId={session.id} active={session.id === activeId} {branch} onSession={updateSession} />
    {/each}
  {/if}
  {#if error}<div class="chat-error shell-error">{error}</div>{/if}
</div>

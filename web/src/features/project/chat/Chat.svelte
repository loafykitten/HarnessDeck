<script lang="ts">
  import { untrack } from "svelte";
  import { getChatSessionsStore } from "../../../stores/chatSessions.svelte";
  import { navigate } from "../../../stores/state.svelte";
  import {
    CHAT_EFFORTS,
    CHAT_MODELS,
    type ChatEffort,
    type ChatHarness,
    type ChatModel,
    type ChatPermissionMode,
  } from "../../../types/chat";
  import ChatPane from "./ChatPane.svelte";

  let { project, branch, activeId }: { project: string; branch?: string; activeId: string | null } = $props();
  const chatSessions = getChatSessionsStore(untrack(() => project));
  let creating = $state(false);
  let name = $state("");
  let harness = $state<ChatHarness>("claude");
  let model = $state<ChatModel>("default");
  let effort = $state<ChatEffort>("high");
  let permissionMode = $state<ChatPermissionMode>("default");

  function selectHarness(next: ChatHarness): void {
    harness = next;
    model = "default";
    effort = next === "codex" ? "medium" : "high";
  }

  async function create(): Promise<void> {
    creating = true;
    try {
      const session = await chatSessions.create({
        name: name.trim() || `chat-${chatSessions.sessions.length + 1}`,
        harness,
        model,
        effort,
        permissionMode,
      });
      name = "";
      chatSessions.showForm = false;
      navigate({ view: "project", name: project, session: session.id });
    } catch {
      // The shared store exposes the error in this shell.
    } finally { creating = false; }
  }
</script>

<div class="glass chat-shell">
  {#if chatSessions.showForm}
    <form class="chat-new-form" onsubmit={(event) => { event.preventDefault(); create(); }}>
      <div class="form-title"><b>New agent chat</b><span>Chat with an agent directly — separate from your tmux sessions</span></div>
      <label>Name<input placeholder={`chat-${chatSessions.sessions.length + 1}`} bind:value={name} /></label>
      <fieldset><legend>Agent</legend><div class="agent-pick"><button type="button" class:on={harness === "claude"} onclick={() => selectHarness("claude")}><span class="hx claude">Claude</span></button><button type="button" class:on={harness === "codex"} onclick={() => selectHarness("codex")}><span class="hx codex">Codex</span></button></div></fieldset>
      <label>Model<select bind:value={model}>{#each CHAT_MODELS[harness] as choice}<option value={choice}>{choice}</option>{/each}</select></label>
      <label>Effort<select bind:value={effort}>{#each CHAT_EFFORTS[harness] as choice}<option value={choice}>{choice}</option>{/each}</select></label>
      <label>Mode<select bind:value={permissionMode}><option value="default">default</option><option value="plan">plan</option><option value="acceptEdits">accept edits</option><option value="bypassPermissions">skip approvals</option></select></label>
      <div class="form-actions"><button type="submit" class="btn" disabled={creating}>{creating ? "Starting…" : "Start chat"}</button>{#if chatSessions.sessions.length}<button type="button" class="btn ghost" onclick={() => chatSessions.showForm = false}>Cancel</button>{/if}</div>
    </form>
  {:else if chatSessions.loading}
    <div class="chat-loading">Loading chats…</div>
  {:else}
    {#each chatSessions.sessions as session (session.id)}
      <ChatPane sessionId={session.id} active={session.id === activeId} {branch} onSession={(updated) => chatSessions.update(updated)} />
    {/each}
  {/if}
  {#if chatSessions.error}<div class="chat-error shell-error">{chatSessions.error}</div>{/if}
</div>

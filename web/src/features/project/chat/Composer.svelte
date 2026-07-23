<script lang="ts">
  import {
    CHAT_EFFORTS,
    CHAT_MODELS,
    type ChatEffort,
    type ChatModel,
    type ChatPermissionMode,
    type ChatSession,
    type ChatStatus,
  } from "../../../types/chat";

  let { session, status, connected, send, setOptions, interrupt }: {
    session: ChatSession | null;
    status: ChatStatus;
    connected: boolean;
    send: (text: string) => void;
    setOptions: (options: { model?: ChatModel; effort?: ChatEffort; permissionMode?: ChatPermissionMode }) => void;
    interrupt: () => void;
  } = $props();
  let text = $state("");
  let model = $state<ChatModel>("default");
  let effort = $state<ChatEffort>("high");
  let permissionMode = $state<ChatPermissionMode>("default");
  const canSend = $derived(connected && session !== null);
  const idlePlaceholder = $derived(session?.harness === "codex" ? "Message Codex…" : "Message Claude…");

  $effect(() => {
    if (!session) return;
    model = session.model;
    effort = session.effort;
    permissionMode = session.permissionMode;
  });

  function submit(): void {
    if (!text.trim() || !canSend) return;
    send(text);
    text = "";
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }
</script>

<div class="chat-composer">
  <textarea rows="3" placeholder={status === "waiting" ? "Answer the request above or queue a message…" : status === "working" ? "Queue another message…" : idlePlaceholder}
    bind:value={text} onkeydown={keydown} disabled={!canSend}></textarea>
  <div class="composer-row">
    <div class="composer-options">
      <label>model<select bind:value={model} onchange={() => setOptions({ model })}>
        {#each CHAT_MODELS[session?.harness ?? "claude"] as choice}<option value={choice}>{choice}</option>{/each}
      </select></label>
      <label>effort<select bind:value={effort} onchange={() => setOptions({ effort })}>
        {#each CHAT_EFFORTS[session?.harness ?? "claude"] as choice}<option value={choice}>{choice}</option>{/each}
      </select></label>
      <label>mode<select bind:value={permissionMode} onchange={() => setOptions({ permissionMode })}>
        <option value="default">default</option><option value="plan">plan</option><option value="acceptEdits">accept edits</option><option value="bypassPermissions" disabled={!session?.canBypassPermissions}>skip approvals</option>
      </select></label>
    </div>
    {#if status === "working"}
      <button class="interrupt" onclick={interrupt}>Interrupt</button>
    {/if}
    <button class="send" disabled={!canSend || !text.trim()} onclick={submit}>Send</button>
  </div>
</div>

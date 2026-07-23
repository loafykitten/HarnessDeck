<script lang="ts">
  import type { ChatEffort, ChatModel, ChatPermissionMode, ChatSession, ChatStatus } from "../../../types/chat";

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
  <textarea rows="3" placeholder={status === "waiting" ? "Answer the request above or queue a message…" : status === "working" ? "Queue another message…" : "Message Claude…"}
    bind:value={text} onkeydown={keydown} disabled={!canSend}></textarea>
  <div class="composer-row">
    <div class="composer-options">
      <label>model<select bind:value={model} onchange={() => setOptions({ model })}>
        <option value="default">default</option><option value="fable">fable</option><option value="opus">opus</option><option value="sonnet">sonnet</option><option value="haiku">haiku</option>
      </select></label>
      <label>effort<select bind:value={effort} onchange={() => setOptions({ effort })}>
        <option value="low">low</option><option value="medium">medium</option><option value="high">high</option><option value="xhigh">xhigh</option><option value="max">max</option>
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

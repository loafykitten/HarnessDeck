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
  import type { PendingChatImage } from "../../../stores/chat.svelte";

  let {
    session, status, connected, draft, attachments, uploadingImages, attachmentError,
    setDraft, attachImage, removeAttachment, send, setOptions, interrupt,
  }: {
    session: ChatSession | null;
    status: ChatStatus;
    connected: boolean;
    draft: string;
    attachments: PendingChatImage[];
    uploadingImages: number;
    attachmentError: string;
    setDraft: (text: string) => void;
    attachImage: (blob: Blob) => Promise<void>;
    removeAttachment: (path: string) => void;
    send: () => void;
    setOptions: (options: { model?: ChatModel; effort?: ChatEffort; permissionMode?: ChatPermissionMode }) => void;
    interrupt: () => void;
  } = $props();
  let model = $state<ChatModel>("default");
  let effort = $state<ChatEffort>("high");
  let permissionMode = $state<ChatPermissionMode>("default");
  const canSend = $derived(connected && session !== null);
  const canSubmit = $derived(canSend && uploadingImages === 0 && (draft.trim().length > 0 || attachments.length > 0));
  const idlePlaceholder = $derived(session?.harness === "codex" ? "Message Codex…" : "Message Claude…");

  $effect(() => {
    if (!session) return;
    model = session.model;
    effort = session.effort;
    permissionMode = session.permissionMode;
  });

  function submit(): void {
    if (!canSubmit) return;
    send();
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      submit();
    }
  }

  async function paste(event: ClipboardEvent): Promise<void> {
    const images = [...(event.clipboardData?.items ?? [])]
      .filter(item => item.type.startsWith("image/"))
      .map(item => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!images.length) return;
    event.preventDefault();
    event.stopPropagation();
    for (const image of images) await attachImage(image);
  }
</script>

<div class="chat-composer">
  {#if attachments.length}
    <div class="attachment-previews" aria-label="Attached images">
      {#each attachments as attachment, index (attachment.path)}
        <div class="attachment-preview">
          <img src={attachment.previewUrl} alt={`Pasted image ${index + 1}`} />
          <button type="button" aria-label={`Remove pasted image ${index + 1}`} title="Remove image"
            onclick={() => removeAttachment(attachment.path)}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3m3 0-1 13H7L6 7m4 4v5m4-5v5" /></svg>
          </button>
        </div>
      {/each}
    </div>
  {/if}
  <textarea rows="3" placeholder={status === "waiting" ? "Answer the request above or queue a message…" : status === "working" ? "Queue another message…" : idlePlaceholder}
    value={draft} oninput={(event) => setDraft(event.currentTarget.value)} onkeydown={keydown} onpaste={paste}
    disabled={!canSend}></textarea>
  {#if uploadingImages}<div class="attachment-notice">Attaching {uploadingImages === 1 ? "image" : `${uploadingImages} images`}…</div>{/if}
  {#if attachmentError}<div class="attachment-notice error">{attachmentError}</div>{/if}
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
    <button class="send" disabled={!canSubmit} onclick={submit}>Send</button>
  </div>
</div>

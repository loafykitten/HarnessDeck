<script module lang="ts">
  import { api } from "../../../lib/api";
  import type { TreeNode } from "../../../types/api";

  const FILE_CACHE_MS = 15_000;
  const fileCache = new Map<string, { at: number; files: Promise<string[]> }>();

  function flattenFiles(nodes: TreeNode[]): string[] {
    const paths: string[] = [];
    for (const node of nodes) {
      if (node.kind === "file") paths.push(node.path);
      else paths.push(...flattenFiles(node.children ?? []));
    }
    return paths;
  }

  function projectFiles(project: string): Promise<string[]> {
    const cached = fileCache.get(project);
    if (cached && Date.now() - cached.at < FILE_CACHE_MS) return cached.files;
    const request = api.projectTree(project)
      .then(tree => flattenFiles(tree.root.children ?? []))
      .catch(error => {
        fileCache.delete(project);
        throw error;
      });
    fileCache.set(project, { at: Date.now(), files: request });
    return request;
  }
</script>

<script lang="ts">
  import { tick } from "svelte";
  import {
    CHAT_EFFORTS,
    CHAT_MODELS,
    type ChatEffort,
    type ChatModel,
    type ChatPermissionMode,
    type ChatSession,
    type ChatStatus,
  } from "../../../types/chat";
  import type { ChatDraft } from "../../../stores/chatSessions.svelte";
  import type { PendingChatImage } from "../../../stores/chat.svelte";

  let {
    project, draft, session, status, connected, attachments, uploadingImages, attachmentError,
    attachImage, removeAttachment, send, setOptions, interrupt,
  }: {
    project: string;
    draft: ChatDraft;
    session: ChatSession | null;
    status: ChatStatus;
    connected: boolean;
    attachments: PendingChatImage[];
    uploadingImages: number;
    attachmentError: string;
    attachImage: (blob: Blob) => Promise<void>;
    removeAttachment: (path: string) => void;
    send: (text: string) => boolean;
    setOptions: (options: { model?: ChatModel; effort?: ChatEffort; permissionMode?: ChatPermissionMode }) => void;
    interrupt: () => void;
  } = $props();
  let model = $state<ChatModel>("default");
  let effort = $state<ChatEffort>("high");
  let permissionMode = $state<ChatPermissionMode>("default");
  let textarea: HTMLTextAreaElement;
  let mentionStart = $state<number | null>(null);
  let mentionCaret = $state(0);
  let filePaths = $state<string[]>([]);
  let filesLoading = $state(false);
  let filesError = $state("");
  let selectedIndex = $state(0);
  let fileRequest = 0;
  let filesFailedAt = 0;
  const FILE_RETRY_MS = 5_000;
  const canSend = $derived(connected && session !== null);
  const canSubmit = $derived(canSend && uploadingImages === 0 && (draft.text.trim().length > 0 || attachments.length > 0));
  const idlePlaceholder = $derived(session?.harness === "codex" ? "Message Codex…" : "Message Claude…");
  const mentionOpen = $derived(mentionStart !== null);
  const popupId = $derived(`file-mention-options-${session?.id ?? project}`);
  const mentionQuery = $derived(mentionStart === null ? "" : draft.text.slice(mentionStart + 1, mentionCaret));
  const matches = $derived.by(() => {
    const query = mentionQuery.toLowerCase();
    return filePaths
      .map(path => ({ path, score: fuzzyScore(path, query) }))
      .filter((match): match is { path: string; score: number } => match.score !== null)
      .sort((a, b) => a.score - b.score || a.path.localeCompare(b.path))
      .slice(0, 10)
      .map(match => match.path);
  });

  $effect(() => {
    if (!session) return;
    model = session.model;
    effort = session.effort;
    permissionMode = session.permissionMode;
  });

  function submit(): void {
    if (!canSubmit) return;
    if (send(draft.text)) {
      draft.text = "";
      closeMention();
    }
  }

  function fuzzyScore(path: string, query: string): number | null {
    if (!query) return 0;
    const value = path.toLowerCase();
    const substring = value.indexOf(query);
    if (substring !== -1) {
      const basename = value.slice(value.lastIndexOf("/") + 1);
      return substring + (basename.startsWith(query) ? -20 : 0) + value.length / 1000;
    }

    let previous = -1;
    let start = -1;
    let gaps = 0;
    for (const character of query) {
      const index = value.indexOf(character, previous + 1);
      if (index === -1) return null;
      if (start === -1) start = index;
      if (previous !== -1) gaps += index - previous - 1;
      previous = index;
    }
    return 100 + start + gaps * 2 + value.length / 1000;
  }

  async function loadFiles(): Promise<void> {
    if (filePaths.length || filesLoading) return;
    if (filesFailedAt && Date.now() - filesFailedAt < FILE_RETRY_MS) return;
    const request = ++fileRequest;
    filesLoading = true;
    filesError = "";
    try {
      const paths = await projectFiles(project);
      if (request === fileRequest && mentionOpen) {
        filePaths = paths;
        filesFailedAt = 0;
      }
    } catch (error) {
      if (request === fileRequest && mentionOpen) {
        filesFailedAt = Date.now();
        filesError = error instanceof Error ? error.message : "Could not load files";
      }
    } finally {
      if (request === fileRequest) filesLoading = false;
    }
  }

  function closeMention(): void {
    if (mentionStart === null) return;
    mentionStart = null;
    selectedIndex = 0;
    filePaths = [];
    filesError = "";
    filesLoading = false;
    fileRequest++;
  }

  function updateMention(target: HTMLTextAreaElement): void {
    const caret = target.selectionStart ?? target.value.length;
    const beforeCaret = target.value.slice(0, caret);
    const found = beforeCaret.match(/(?:^|\s)@([^\s@]*)$/);
    if (!found) {
      closeMention();
      return;
    }

    const start = caret - found[1].length - 1;
    if (mentionStart !== start || mentionCaret !== caret) selectedIndex = 0;
    mentionStart = start;
    mentionCaret = caret;
    void loadFiles();
  }

  function input(event: Event): void {
    const target = event.currentTarget as HTMLTextAreaElement;
    draft.text = target.value;
    updateMention(target);
  }

  async function selectPath(path: string): Promise<void> {
    if (mentionStart === null) return;
    const suffix = draft.text.slice(mentionCaret).match(/^[^\s@]*/)?.[0] ?? "";
    const remainder = draft.text.slice(mentionCaret + suffix.length);
    const pad = /^\s/.test(remainder) ? "" : " ";
    const caret = mentionStart + path.length + 2;
    draft.text = `${draft.text.slice(0, mentionStart)}@${path}${pad}${remainder}`;
    closeMention();
    await tick();
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }

  function keydown(event: KeyboardEvent): void {
    if (event.isComposing) return; // don't hijack IME candidate commits
    if (mentionOpen) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        if (matches.length) selectedIndex = (selectedIndex + 1) % matches.length;
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        if (matches.length) selectedIndex = (selectedIndex - 1 + matches.length) % matches.length;
        return;
      }
      if (event.key === "Enter" || event.key === "Tab") {
        if (event.key === "Enter" && event.shiftKey) return; // newline falls through
        const path = matches[selectedIndex];
        if (!path) {
          // no matches: Enter must not submit, but let Tab move focus normally
          if (event.key === "Enter") event.preventDefault();
          return;
        }
        event.preventDefault();
        void selectPath(path);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        closeMention();
        return;
      }
    }
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
  <div class="composer-input">
    {#if mentionOpen}
      <div class="file-mention-popup" id={popupId} role="listbox" aria-label="Project files">
        <div class="file-mention-title"><span>Project files</span><kbd>esc</kbd></div>
        {#if filesLoading}
          <div class="file-mention-state">Loading files…</div>
        {:else if filesError}
          <div class="file-mention-state error">{filesError}</div>
        {:else if matches.length === 0}
          <div class="file-mention-state">No matching files</div>
        {:else}
          {#each matches as path, index (path)}
            <button type="button" id={`${popupId}-${index}`} role="option"
              aria-selected={index === selectedIndex} class:selected={index === selectedIndex}
              onmousedown={(event) => event.preventDefault()} onclick={() => selectPath(path)}>
              <span class="file-mention-at">@</span><span>{path}</span>
            </button>
          {/each}
        {/if}
      </div>
    {/if}
    <textarea rows="3" placeholder={status === "waiting" ? "Answer the request above or queue a message…" : status === "working" ? "Queue another message…" : idlePlaceholder}
      bind:this={textarea} value={draft.text} oninput={input} onkeydown={keydown} onpaste={paste}
      onblur={() => closeMention()}
      onclick={(event) => updateMention(event.currentTarget)}
      onkeyup={(event) => { if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) updateMention(event.currentTarget); }}
      aria-autocomplete="list" aria-controls={mentionOpen ? popupId : undefined}
      aria-activedescendant={mentionOpen && matches[selectedIndex] ? `${popupId}-${selectedIndex}` : undefined}
      disabled={!canSend}></textarea>
  </div>
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

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

  let { project, session, status, connected, send, setOptions, interrupt }: {
    project: string;
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
  let textarea: HTMLTextAreaElement;
  let mentionStart = $state<number | null>(null);
  let mentionCaret = $state(0);
  let filePaths = $state<string[]>([]);
  let filesLoading = $state(false);
  let filesError = $state("");
  let selectedIndex = $state(0);
  let fileRequest = 0;
  const canSend = $derived(connected && session !== null);
  const idlePlaceholder = $derived(session?.harness === "codex" ? "Message Codex…" : "Message Claude…");
  const mentionOpen = $derived(mentionStart !== null);
  const popupId = $derived(`file-mention-options-${session?.id ?? project}`);
  const mentionQuery = $derived(mentionStart === null ? "" : text.slice(mentionStart + 1, mentionCaret));
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
    if (!text.trim() || !canSend) return;
    send(text);
    text = "";
    closeMention();
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
    const request = ++fileRequest;
    filesLoading = true;
    filesError = "";
    try {
      const paths = await projectFiles(project);
      if (request === fileRequest && mentionOpen) filePaths = paths;
    } catch (error) {
      if (request === fileRequest && mentionOpen) {
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
    text = target.value;
    updateMention(target);
  }

  async function selectPath(path: string): Promise<void> {
    if (mentionStart === null) return;
    const suffix = text.slice(mentionCaret).match(/^[^\s@]*/)?.[0] ?? "";
    const caret = mentionStart + path.length + 2;
    text = `${text.slice(0, mentionStart)}@${path} ${text.slice(mentionCaret + suffix.length)}`;
    closeMention();
    await tick();
    textarea.focus();
    textarea.setSelectionRange(caret, caret);
  }

  function keydown(event: KeyboardEvent): void {
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
        event.preventDefault();
        const path = matches[selectedIndex];
        if (path) void selectPath(path);
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
</script>

<div class="chat-composer">
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
      bind:this={textarea} value={text} oninput={input} onkeydown={keydown}
      onclick={(event) => updateMention(event.currentTarget)}
      onkeyup={(event) => { if (!["ArrowUp", "ArrowDown", "Enter", "Tab", "Escape"].includes(event.key)) updateMention(event.currentTarget); }}
      aria-autocomplete="list" aria-controls={mentionOpen ? popupId : undefined}
      aria-activedescendant={mentionOpen && matches[selectedIndex] ? `${popupId}-${selectedIndex}` : undefined}
      disabled={!canSend}></textarea>
  </div>
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

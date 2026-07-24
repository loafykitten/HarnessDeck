<script lang="ts">
  // Renders a permission request's raw tool input as a purpose-built view.
  // Dispatch is shape-first rather than name-first, because Claude and Codex
  // use the same tool names for quite different payloads.
  import Diff from "./Diff.svelte";
  import { allAdded, lineDiff, parseUnified, type DiffLine } from "../../../lib/diff";
  import { asRecord, asString } from "../../../lib/tools";

  let { input }: { input: Record<string, unknown> } = $props();

  const FIELD_LABELS: Record<string, string> = {
    cwd: "in", reason: "why", description: "what", subagent_type: "agent",
    model: "model", timeout: "timeout", output_mode: "output", glob: "glob",
    path: "in", offset: "from line", limit: "lines", pages: "pages",
    replace_all: "replace all", run_in_background: "background", grantRoot: "grant root",
  };
  const SHOWN_META = Object.keys(FIELD_LABELS);

  let filePath = $derived(asString(input.file_path) ?? asString(input.notebook_path));

  /** Quote an argv element so the preview means what the harness will run. */
  function shellQuote(part: string): string {
    return /^[\w./:=@%+-]+$/.test(part) ? part : `'${part.replaceAll("'", "'\\''")}'`;
  }

  let command = $derived.by(() => {
    const raw = input.command;
    if (typeof raw === "string") return raw;
    // Legacy Codex approvals carry argv arrays; keep the boundaries visible.
    if (Array.isArray(raw)) return raw.filter(part => typeof part === "string").map(shellQuote).join(" ");
    // Modern Codex approvals may omit `command` and describe the work as
    // parsed actions instead — every variant carries a `command` string.
    if (Array.isArray(input.actions)) {
      const parts = input.actions
        .map(action => asString(asRecord(action)?.command))
        .filter((part): part is string => part !== null);
      if (parts.length) return parts.join("\n");
    }
    return null;
  });

  /** Codex hands over a map of path → change, each with its own diff. */
  let fileChanges = $derived.by(() => {
    const raw = asRecord(input.fileChanges);
    if (!raw) return [];
    return Object.entries(raw).map(([path, value]) => {
      const change = asRecord(value);
      const content = asString(change?.content);
      const unified = asString(change?.unified_diff);
      if (unified) return { path, note: asString(change?.move_path) ? `→ ${asString(change?.move_path)}` : "", lines: parseUnified(unified) };
      if (change?.type === "add" && content !== null) return { path, note: "new file", lines: allAdded(content) };
      if (change?.type === "delete") {
        const lines: DiffLine[] = content === null ? [] : content.split("\n").map(text => ({ kind: "del", text }));
        return { path, note: "deleted", lines };
      }
      return { path, note: "", lines: [] as DiffLine[] };
    });
  });

  let editDiff = $derived.by(() => {
    const before = asString(input.old_string);
    const after = asString(input.new_string);
    return before !== null && after !== null ? lineDiff(before, after) : null;
  });

  let writeContent = $derived(asString(input.content));
  let prompt = $derived(asString(input.prompt));
  let pattern = $derived(asString(input.pattern));
  let url = $derived(asString(input.url) ?? asString(input.query));

  /** Small scalar fields worth surfacing next to the main view. */
  let meta = $derived(
    SHOWN_META
      .filter(key => input[key] !== undefined && input[key] !== null && input[key] !== false && input[key] !== "")
      .map(key => ({ key, label: FIELD_LABELS[key], value: String(input[key]) })),
  );

  /** Anything the views above didn't already account for. */
  const HANDLED = new Set([
    ...SHOWN_META, "file_path", "notebook_path", "command", "fileChanges", "old_string",
    "new_string", "content", "prompt", "pattern", "url", "query", "itemId", "callId",
    "approvalId", "conversationId", "threadId", "turnId", "environmentId", "startedAtMs",
    "actions", "parsedCmd", "permissions",
  ]);
  let extra = $derived(Object.entries(input).filter(([key]) => !HANDLED.has(key)));

  let permissions = $derived.by(() => {
    const raw = input.permissions;
    if (Array.isArray(raw)) return raw.map(entry => typeof entry === "string" ? entry : JSON.stringify(entry));
    const record = asRecord(raw);
    return record ? Object.entries(record).map(([key, value]) => `${key}: ${JSON.stringify(value)}`) : [];
  });
</script>

<div class="perm-detail">
  {#if editDiff}
    <Diff lines={editDiff} label={filePath ?? "edit"} />
  {:else if writeContent !== null}
    <Diff lines={allAdded(writeContent)} label={filePath ?? "new file"} note="new file" />
  {:else if fileChanges.length}
    {#each fileChanges as change (change.path)}
      <Diff lines={change.lines} label={change.path} note={change.note} />
    {/each}
  {:else if command !== null}
    <pre class="perm-command"><span class="perm-prompt">$</span> {command}</pre>
  {:else if filePath}
    <div class="perm-subject">{filePath}</div>
  {:else if pattern}
    <div class="perm-subject">{pattern}</div>
  {:else if url}
    <div class="perm-subject">{url}</div>
  {/if}

  {#if permissions.length}
    <ul class="perm-list">
      {#each permissions as entry, i (i)}<li>{entry}</li>{/each}
    </ul>
  {/if}

  {#if prompt}
    <details class="perm-more">
      <summary>prompt</summary>
      <pre>{prompt}</pre>
    </details>
  {/if}

  {#if meta.length}
    <dl class="perm-meta">
      {#each meta as field (field.key)}
        <div><dt>{field.label}</dt><dd>{field.value}</dd></div>
      {/each}
    </dl>
  {/if}

  {#if extra.length}
    <details class="perm-more">
      <summary>other fields</summary>
      <pre>{JSON.stringify(Object.fromEntries(extra), null, 2)}</pre>
    </details>
  {/if}
</div>

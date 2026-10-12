<script lang="ts">
  import PermissionDetail from "./PermissionDetail.svelte";
  import { toolLook } from "../../../lib/tools";

  let { toolName, input, resolved, sending = false, respond }: {
    toolName: string;
    input: Record<string, unknown>;
    resolved?: string;
    /** Answered here but not yet confirmed by the server. */
    sending?: boolean;
    respond: (behavior: "allow" | "deny", always?: boolean, message?: string) => void;
  } = $props();
  let denying = $state(false);
  let message = $state("");

  let look = $derived(toolLook(toolName));
</script>

<div class="approval-card" data-kind={look.kind}>
  <div class="request-title">
    <span class="perm-glyph">{look.glyph}</span>
    <b>{toolName}</b>
    <span class="request-sub">needs permission</span>
    {#if !resolved}<span class="tdot waiting"></span>{/if}
  </div>
  <PermissionDetail {input} />
  {#if resolved}
    <div class="request-resolved" class:denied={resolved === "denied"}
      class:dismissed={resolved === "dismissed"}>{resolved}</div>
  {:else if sending}
    <div class="request-resolved dismissed">sending…</div>
  {:else if denying}
    <input aria-label="Reason for denial" placeholder="Optional message…" bind:value={message} />
    <div class="request-actions">
      <button class="deny" onclick={() => respond("deny", false, message)}>Deny</button>
      <button onclick={() => denying = false}>Cancel</button>
    </div>
  {:else}
    <div class="request-actions">
      <button class="allow" onclick={() => respond("allow")}>Allow</button>
      <button onclick={() => respond("allow", true)}>Always allow</button>
      <button class="deny" onclick={() => denying = true}>Deny</button>
    </div>
  {/if}
</div>

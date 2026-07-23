<script lang="ts">
  let { toolName, input, resolved, respond }: {
    toolName: string;
    input: Record<string, unknown>;
    resolved?: string;
    respond: (behavior: "allow" | "deny", always?: boolean, message?: string) => void;
  } = $props();
  let denying = $state(false);
  let message = $state("");
</script>

<div class="approval-card">
  <div class="request-title"><span class="tdot waiting"></span><b>{toolName}</b> needs permission</div>
  <pre>{JSON.stringify(input, null, 2)}</pre>
  {#if resolved}
    <div class="request-resolved" class:denied={resolved === "denied"}
      class:dismissed={resolved === "dismissed"}>{resolved}</div>
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

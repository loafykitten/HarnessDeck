<script lang="ts">
  import { fmtDate } from "../../utils/format";

  let { plan }: { plan: { label: string; renewsAt: string | null } } = $props();
</script>

<span class="hc-plan">
  <span class="plan-badge"><span class="spk"></span><b>{plan.label}</b></span>
  {#if plan.renewsAt}<span class="plan-renew">renews {fmtDate(plan.renewsAt)}</span>{/if}
</span>

<style>
  /* plan-badge is 16px for the old plan card; header scale is smaller */
  .hc-plan{display:inline-flex;align-items:baseline;gap:8px}
  .hc-plan :global(.plan-badge){font-size:14px}
</style>

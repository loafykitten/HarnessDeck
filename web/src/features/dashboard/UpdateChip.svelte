<script lang="ts">
  import { app, applyUpdate, refreshUpdate } from "../../stores/state.svelte";
  import { fmtAgo } from "../../utils/format";
  import type { HarnessId } from "../../types/api";

  let { harness, label }: { harness: HarnessId; label: string } = $props();

  // A finished run stays on screen briefly so the outcome is seen, then the
  // chip falls back to the plain version line. Both outcomes are age-gated:
  // the server keeps the last job forever, so an ungated failure would pin the
  // chip to "Update failed" for the life of the process. (refreshUpdate
  // schedules a re-fetch at the end of the window — Date.now() isn't reactive.)
  const v = $derived.by(() => {
    const u = app.updates?.[harness] ?? null;
    const job = u?.job ?? null;
    const updating = job?.status === "running";
    const jobFresh = !!job?.finishedAt && app.jobDisplayUntil[harness] !== null;
    const justUpdated = job?.status === "done" && jobFresh;
    const failed = job?.status === "error" && jobFresh;
    return {
      updating, failed, justUpdated,
      ready: !!u?.updateAvailable,
      canUpdate: !!u?.updateAvailable && !updating,
      text: updating ? `Updating to ${u?.latest ?? "the latest version"}…`
        : failed ? "Update failed"
        : justUpdated ? (u?.installed ? `Updated to ${u.installed}` : "Update complete")
        : u?.updateAvailable ? `${label} ${u.latest} available`
        : u?.installed ? `${label} ${u.installed}`
        : app.updateChecking ? "Checking…"
        : "Version unknown",
      title: updating ? `Running ${harness} update — running sessions keep their current version until they restart.`
        : failed ? `${harness} update failed:\n${job?.output ?? ""}`
        : u?.error ? u.error
        : u?.updateAvailable ? `You're on ${u.installed}. Click Update to install ${u.latest}.`
        : u ? `Up to date · checked ${fmtAgo(u.checkedAt)}`
        : `Checking for a newer ${label}`,
    };
  });
</script>

<div class="pill upd" class:ready={v.ready} class:busy={v.updating}
  class:failed={v.failed} class:fresh={v.justUpdated} title={v.title}>
  <span class="upd-dot"></span>
  <span class="upd-text">{v.text}</span>
  {#if v.canUpdate}
    <button class="upd-go" onclick={() => applyUpdate(harness)}>Update</button>
  {/if}
  <button class="upd-check" onclick={() => refreshUpdate(true)} disabled={app.updateChecking || v.updating}
    aria-label="Check for updates now">
    <svg class:spin={app.updateChecking || v.updating} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" stroke-width="2.2" stroke-linecap="round">
      <path d="M20 11a8 8 0 1 0-.6 4"/><path d="M20 4v7h-7"/>
    </svg>
  </button>
</div>

<style>
  /* updater chip — quiet at rest, lit when an update is waiting */
  .upd{gap:9px;padding-right:6px;color:var(--ink-dim)}
  .upd-dot{width:7px;height:7px;border-radius:50%;background:var(--ink-faint);flex-shrink:0}
  .upd-text{white-space:nowrap}
  .upd.ready{border-color:var(--glass-brd-lit);color:var(--ink);
    box-shadow:0 0 22px -8px rgba(var(--accent-rgb),.75)}
  .upd.ready .upd-dot{background:var(--accent);box-shadow:0 0 10px var(--accent);animation:pulse 2s infinite}
  .upd.busy .upd-dot,.upd.fresh .upd-dot{background:var(--ok);box-shadow:0 0 10px var(--ok)}
  .upd.busy .upd-dot{animation:pulse 1.1s infinite}
  .upd.failed .upd-dot{background:var(--accent-2);box-shadow:0 0 10px var(--accent-2)}

  .upd-go{font:inherit;font-size:11px;font-weight:700;letter-spacing:.04em;cursor:pointer;
    padding:4px 11px;border-radius:999px;border:1px solid transparent;color:#fff;
    background:linear-gradient(135deg,var(--accent),var(--accent-3));
    box-shadow:0 0 16px -6px rgba(var(--accent-rgb),.9)}
  .upd-go:hover{filter:brightness(1.12)}

  .upd-check{display:grid;place-items:center;width:24px;height:24px;padding:0;cursor:pointer;
    border:0;border-radius:50%;background:transparent;color:var(--ink-faint)}
  .upd-check svg{width:14px;height:14px}
  .upd-check:hover:not(:disabled){color:var(--ink);background:var(--glass-2)}
  .upd-check:disabled{cursor:default}
  .upd-check svg.spin{animation:updspin 1s linear infinite}
  @keyframes updspin{to{transform:rotate(360deg)}}
  @media (prefers-reduced-motion:reduce){
    .upd-check svg.spin,.upd.ready .upd-dot,.upd.busy .upd-dot{animation:none}
  }
</style>

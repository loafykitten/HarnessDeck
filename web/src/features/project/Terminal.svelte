<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { api } from "../../lib/api";

  let { sessionId, active, onEnded }: {
    sessionId: string;
    active: boolean;
    onEnded?: () => void;
  } = $props();

  let host: HTMLDivElement;
  let pasteFlash = $state("");
  let reconnecting = $state(false);
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let ws: WebSocket | null = null;
  let disposed = false;
  let retryDelay = 1000;
  let pingTimer: ReturnType<typeof setInterval> | null = null;

  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    const v = (name: string) => css.getPropertyValue(name).trim();
    return {
      background: v("--term-bg") || "#0d0921",
      foreground: v("--term-ink") || v("--ink") || "#f4f0ff",
      cursor: v("--accent") || "#ff5ec7",
      cursorAccent: v("--term-cursor-accent") || "#000000",
      selectionBackground: v("--term-sel") || "rgba(160,107,255,.35)",
    };
  }

  let pending: string[] = [];
  function sendInput(data: string) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    } else {
      pending.push(data); // typed while (re)connecting — flush on open
    }
  }

  async function copySelection() {
    const text = term?.getSelection();
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      pasteFlash = "📋 copied";
    } catch {
      pasteFlash = "copy failed";
    }
    setTimeout(() => pasteFlash = "", 2000);
  }

  function doFit() {
    if (!fit || !term || ws?.readyState !== WebSocket.OPEN) return;
    fit.fit();
    ws!.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  function connect() {
    if (disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/session/${encodeURIComponent(sessionId)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => {
      reconnecting = false;
      retryDelay = 1000;
      doFit();
      for (const data of pending.splice(0)) {
        ws!.send(JSON.stringify({ type: "input", data }));
      }
      // keepalive: Bun closes idle sockets; background tabs throttle timers,
      // so ping well inside the server's 960s window
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 30_000);
    };
    ws.onmessage = (e) => {
      term?.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    };
    ws.onclose = async () => {
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (disposed) return;
      // Only declare the session dead if tmux says it's gone; otherwise this
      // was a dropped socket (server restart, sleep, idle timeout) — reconnect.
      const alive = await api.sessions()
        .then(list => list.some(s => s.id === sessionId))
        .catch(() => true); // can't reach server → assume alive, keep retrying
      if (disposed) return;
      if (!alive) {
        term?.write("\r\n\x1b[2m— session ended —\x1b[0m\r\n");
        onEnded?.();
        return;
      }
      reconnecting = true;
      setTimeout(() => {
        if (disposed) return;
        term?.reset(); // tmux repaints the full screen on attach
        connect();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 10_000);
    };
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 5000,
      // App mouse tracking consumes plain drags; Option-drag must still select terminal text.
      macOptionClickForcesSelection: true,
      theme: themeColors(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    // Shift+Enter → newline as a bracketed paste of "\n", sent atomically.
    // It must be ONE write: xterm auto-answers Claude's cursor-position
    // queries on this same channel, and any multi-write encoding (\+CR with
    // a gap, etc.) gets a query response interleaved and submits instead.
    term.attachCustomKeyEventHandler((e) => {
      if (e.key === "Enter" && e.shiftKey) {
        // cancel EVERY event type: an uncancelled keypress makes xterm emit
        // a stray "\r" right after ours, which submits the prompt
        if (e.type === "keydown") sendInput("\x1b[200~\n\x1b[201~");
        return false;
      }
      // ⌘Left / ⌘Right → readline start / end. Cancel every event type
      // so neither xterm nor the browser handles a stray follow-up event.
      if (e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey &&
          (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
        e.preventDefault();
        if (e.type === "keydown") sendInput(e.key === "ArrowLeft" ? "\x01" : "\x05");
        return false;
      }
      // Copy the terminal selection on ⌘C / ⌃C. xterm's selection is a render
      // overlay, not a DOM selection, so the browser's native copy grabs
      // nothing — we do it by hand. With no selection, ⌃C falls through to
      // tmux as SIGINT (interrupt) as usual.
      if (e.type === "keydown" && (e.metaKey || e.ctrlKey) && e.key === "c" && term?.hasSelection()) {
        copySelection();
        return false;
      }
      return true;
    });

    term.onData(d => sendInput(d));
    connect();

    // image paste → upload → backend types the temp-file path into claude
    const onPaste = async (e: ClipboardEvent) => {
      const item = [...(e.clipboardData?.items ?? [])].find(i => i.type.startsWith("image/"));
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      const blob = item.getAsFile();
      if (!blob) return;
      try {
        await api.pasteImage(sessionId, blob);
        pasteFlash = "📎 image attached";
      } catch (err) {
        pasteFlash = "paste failed";
        console.error(err);
      }
      setTimeout(() => pasteFlash = "", 3000);
    };
    host.addEventListener("paste", onPaste, true);

    const ro = new ResizeObserver(() => { if (active) doFit(); });
    ro.observe(host);

    // theme changes re-color the live terminal
    const mo = new MutationObserver(() => { if (term) term.options.theme = themeColors(); });
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

    return () => {
      disposed = true;
      if (pingTimer) clearInterval(pingTimer);
      ro.disconnect();
      mo.disconnect();
      host.removeEventListener("paste", onPaste, true);
      ws?.close();
      term?.dispose();
    };
  });

  $effect(() => {
    if (active) {
      // refit when this tab becomes visible again
      requestAnimationFrame(() => { doFit(); term?.focus(); });
    }
  });
</script>

<div class="term-view" style:display={active ? "block" : "none"}>
  <div bind:this={host} style="height:100%"></div>
  <div class="term-tube"></div>
  <div class="term-scan"></div>
</div>
{#if active}
  <div class="input-hint">
    <span><kbd>⌘V</kbd> paste image</span>
    <span><kbd>⌥drag</kbd> select · <kbd>⌘C</kbd> copy</span>
    <span><kbd>⇧⏎</kbd> newline</span>
    <span><kbd>⏎</kbd> send</span>
    <span><kbd>esc</kbd> interrupt</span>
    {#if reconnecting}<span class="paste-flash gen-spin">↻ reconnecting…</span>{/if}
    {#if pasteFlash}<span class="paste-flash">{pasteFlash}</span>{/if}
  </div>
{/if}

<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { ClipboardAddon, type IClipboardProvider } from "@xterm/addon-clipboard";
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
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let suspended = false;
  // A hidden tab drops its socket (and with it the server-side tmux-attach
  // pty) after this long; the xterm buffer stays, so scrollback survives the
  // nap and tmux repaints the live screen on reattach. Long enough that
  // quick tab flips never pay a reconnect.
  const SUSPEND_AFTER_MS = 60_000;
  let osc52Pending: string | null = null;
  let lastSentCols: number | null = null;
  let lastSentRows: number | null = null;

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
  let pendingBytes = 0;
  let pendingCapped = false;
  const MAX_PENDING_BYTES = 64 * 1024;
  function sendInput(data: string) {
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "input", data }));
    } else {
      if (pendingCapped) return;
      const bytes = new TextEncoder().encode(data).byteLength;
      if (pendingBytes + bytes > MAX_PENDING_BYTES) {
        pendingCapped = true;
        return;
      }
      pending.push(data); // typed while (re)connecting — flush on open
      pendingBytes += bytes;
      if (pendingBytes === MAX_PENDING_BYTES) pendingCapped = true;
    }
  }

  async function copyText(text: string): Promise<boolean> {
    let copyEventFired = false;
    const onCopy = (e: ClipboardEvent) => {
      copyEventFired = true;
      e.clipboardData?.setData("text/plain", text);
      e.preventDefault();
    };

    // Safari doesn't count a keydown shortcut as activation for the async clipboard API.
    document.addEventListener("copy", onCopy, { once: true });
    let copied = false;
    try {
      copied = document.execCommand("copy") && copyEventFired;
    } catch {} finally {
      document.removeEventListener("copy", onCopy);
    }

    if (!copied) {
      try {
        await navigator.clipboard.writeText(text);
        copied = true;
      } catch {}
    }
    return copied;
  }

  async function copySelection() {
    const text = term?.getSelection();
    if (!text) return;

    const copied = await copyText(text);
    pasteFlash = copied ? "📋 copied" : "copy failed";
    setTimeout(() => pasteFlash = "", 2000);
  }

  const clipboardProvider: IClipboardProvider = {
    // Never expose the user's clipboard to apps running in the terminal.
    readText: (_selection) => Promise.resolve(""),
    async writeText(_selection, text) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        // WebKit rejects writes outside a gesture stack, so let the next ⌘C finish it.
        // Expire the stash with its hint — a minutes-old ⌘C must not paste stale text.
        osc52Pending = text;
        pasteFlash = "📋 ⌘C to finish copy";
        setTimeout(() => {
          if (osc52Pending === text) { osc52Pending = null; pasteFlash = ""; }
        }, 15_000);
      }
    },
  };

  function doFit() {
    if (!fit || !term || ws?.readyState !== WebSocket.OPEN) return;
    fit.fit();
    if (term.cols === lastSentCols && term.rows === lastSentRows) return;
    ws!.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
    lastSentCols = term.cols;
    lastSentRows = term.rows;
  }

  /** Deliberately drop the socket for a long-hidden tab. Stale-socket guards
      (ws !== sock) keep its late close event from clearing the next socket's
      timers or scheduling a duplicate reconnect. */
  function suspend() {
    suspendTimer = null;
    if (disposed || suspended) return;
    suspended = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    reconnecting = false;
    const sock = ws;
    ws = null;
    sock?.close();
  }

  function connect() {
    if (disposed) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/ws/session/${encodeURIComponent(sessionId)}`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    sock.onopen = () => {
      if (ws !== sock) return;
      lastSentCols = null;
      lastSentRows = null;
      reconnecting = false;
      retryDelay = 1000;
      doFit();
      for (const data of pending.splice(0)) {
        sock.send(JSON.stringify({ type: "input", data }));
      }
      pendingBytes = 0;
      pendingCapped = false;
      // keepalive: Bun closes idle sockets; background tabs throttle timers,
      // so ping well inside the server's 960s window
      pingTimer = setInterval(() => {
        if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "ping" }));
      }, 30_000);
    };
    sock.onmessage = (e) => {
      if (ws !== sock) return;
      term?.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    };
    sock.onclose = async () => {
      if (ws !== sock) return; // suspended or superseded — a deliberate close
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      if (disposed) return;
      // Only declare the session dead if tmux says it's gone; otherwise this
      // was a dropped socket (server restart, sleep, idle timeout) — reconnect.
      const alive = await api.sessionAlive(sessionId)
        .then(res => res.alive)
        .catch(() => true); // can't reach server → assume alive, keep retrying
      if (disposed || suspended || ws !== sock) return;
      if (!alive) {
        term?.write("\r\n\x1b[2m— session ended —\x1b[0m\r\n");
        onEnded?.();
        return;
      }
      reconnecting = true;
      retryTimer = setTimeout(() => {
        retryTimer = null;
        if (disposed || suspended) return;
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
    term.loadAddon(new ClipboardAddon(undefined, clipboardProvider));
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
      // tmux as SIGINT (interrupt) as usual. Swallow ⌘C to avoid Safari's alert beep.
      if (e.metaKey && !e.ctrlKey && e.key === "c") {
        if (e.type === "keydown") {
          e.preventDefault();
          if (term?.hasSelection()) {
            osc52Pending = null;
            copySelection();
          } else if (osc52Pending !== null) {
            const text = osc52Pending;
            const copied = copyText(text);
            osc52Pending = null;
            void copied.then(success => {
              pasteFlash = success ? "📋 copied" : "copy failed";
              setTimeout(() => pasteFlash = "", 2000);
            });
          }
        }
        return false;
      }
      if (e.type === "keydown" && e.ctrlKey && e.key === "c" && term?.hasSelection()) {
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
      if (retryTimer) clearTimeout(retryTimer);
      if (suspendTimer) clearTimeout(suspendTimer);
      ro.disconnect();
      mo.disconnect();
      host.removeEventListener("paste", onPaste, true);
      ws?.close();
      term?.dispose();
    };
  });

  $effect(() => {
    if (active) {
      if (suspendTimer) { clearTimeout(suspendTimer); suspendTimer = null; }
      if (suspended) {
        // no term.reset() here: the buffer holds this tab's scrollback, and
        // tmux's attach repaint redraws the viewport in place on top of it
        suspended = false;
        connect();
      }
      // refit when this tab becomes visible again
      requestAnimationFrame(() => { doFit(); term?.focus(); });
    } else {
      suspendTimer ??= setTimeout(suspend, SUSPEND_AFTER_MS);
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

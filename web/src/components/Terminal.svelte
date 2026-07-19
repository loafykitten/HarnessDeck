<script lang="ts">
  import { onMount } from "svelte";
  import { Terminal } from "@xterm/xterm";
  import { FitAddon } from "@xterm/addon-fit";
  import { api } from "../lib/api";

  let { sessionId, active, onEnded }: {
    sessionId: string;
    active: boolean;
    onEnded?: () => void;
  } = $props();

  let host: HTMLDivElement;
  let pasteFlash = $state("");
  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let ws: WebSocket | null = null;

  function themeColors() {
    const css = getComputedStyle(document.documentElement);
    return {
      background: css.getPropertyValue("--term-bg").trim() || "#0d0921",
      foreground: css.getPropertyValue("--ink").trim() || "#f4f0ff",
      cursor: css.getPropertyValue("--accent").trim() || "#ff5ec7",
      cursorAccent: "#000000",
      selectionBackground: "rgba(160,107,255,.35)",
    };
  }

  function doFit() {
    if (!fit || !term || !ws || ws.readyState !== WebSocket.OPEN) return;
    fit.fit();
    ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
  }

  onMount(() => {
    term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", Menlo, Monaco, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowTransparency: false,
      scrollback: 5000,
      theme: themeColors(),
    });
    fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);

    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/session/${encodeURIComponent(sessionId)}`);
    ws.binaryType = "arraybuffer";
    ws.onopen = () => doFit();
    ws.onmessage = (e) => {
      term!.write(typeof e.data === "string" ? e.data : new Uint8Array(e.data));
    };
    ws.onclose = () => {
      term?.write("\r\n\x1b[2m— session ended —\x1b[0m\r\n");
      onEnded?.();
    };

    term.onData(d => {
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "input", data: d }));
    });

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
    <span><kbd>⏎</kbd> send</span>
    <span><kbd>esc</kbd> interrupt</span>
    {#if pasteFlash}<span class="paste-flash">{pasteFlash}</span>{/if}
  </div>
{/if}

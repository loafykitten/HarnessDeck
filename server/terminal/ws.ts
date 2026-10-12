import { appendFileSync } from "node:fs";
import { spawn as ptySpawn, type IPty } from "bun-pty";
import type { WebSocketHandler } from "bun";
import { newlineIntoSession } from "./sessions";

const WS_DEBUG_LOG = process.env.HARNESSDECK_WS_DEBUG === "1" ? "/tmp/harnessdeck-ws-debug.log" : null;

export type WsData = { sessionId: string; pty?: IPty };

/** Attach a browser terminal to a tmux session over a pty. */
export const terminalWebsocket: WebSocketHandler<WsData> = {
  open(ws) {
    const pty = ptySpawn("tmux", ["attach", "-t", `=${ws.data.sessionId}`], {
      name: "xterm-256color",
      cols: 220,
      rows: 50,
      env: { ...process.env, TERM: "xterm-256color", LANG: process.env.LANG ?? "en_US.UTF-8" },
    });
    ws.data.pty = pty;
    pty.onData(chunk => {
      try { ws.send(chunk); } catch { /* socket gone */ }
    });
    pty.onExit(() => {
      try { ws.close(1000, "session ended"); } catch { /* already closed */ }
    });
  },
  message(ws, msg) {
    const pty = ws.data.pty;
    if (!pty) return;
    if (typeof msg === "string") {
      if (WS_DEBUG_LOG) appendFileSync(WS_DEBUG_LOG, JSON.stringify(msg) + "\n");
      let m: any = null;
      try { m = JSON.parse(msg); } catch { /* raw input */ }
      if (m && typeof m === "object") {
        if (m.type === "resize" && m.cols > 0 && m.rows > 0) {
          pty.resize(Math.min(m.cols, 500), Math.min(m.rows, 200));
        } else if (m.type === "input" && typeof m.data === "string") {
          pty.write(m.data);
        } else if (m.type === "newline") {
          newlineIntoSession(ws.data.sessionId);
        }
        // anything else (e.g. keepalive pings) is deliberately ignored —
        // never let stray JSON get typed into the terminal
        return;
      }
      pty.write(msg);
    } else {
      pty.write(new TextDecoder().decode(msg));
    }
  },
  close(ws) {
    ws.data.pty?.kill(); // detaches this client; tmux session lives on
    ws.data.pty = undefined;
  },
};

# Claude Command

A personal control center for [Claude Code](https://claude.com/claude-code), running as a small web app on your own Mac. It starts at login, lives at `http://localhost:4553`, and gives you one place to see everything Claude is doing across your projects — and to jump straight into any session from the browser.

![Dashboard](docs/screenshots/dashboard.webp)

## What it does

### Dashboard

The home screen greets you by name, with your local weather and a whimsical one-liner written fresh each hour by Claude itself. Below that:

- **Usage at a glance** — how much of your current 5-hour window and weekly allowance you've used, when each resets, and how many tokens you've burned this billing cycle (with the equivalent API price, so you can see what the subscription is saving you).
- **Plan card** — your subscription tier and renewal date.
- **Active sessions** — every Claude session currently running, with a live idle/working status. One click drops you into its terminal.
- **Projects** — every folder in `~/Developer`, with recent activity and running-session counts.

### Projects & terminals

Each project gets its own page with tabbed terminal sessions — one tab per Claude session, so you can run several in parallel and flip between them.

![Project view with a live Claude session](docs/screenshots/project.webp)

Sessions run inside [tmux](https://github.com/tmux/tmux) behind the scenes, which means they survive server restarts, closed browser tabs, and even reboots of the app — reopen the page and your session is right where you left it. You can also **paste an image straight into the terminal**: it's saved to disk and the file path is typed into Claude's input for you, ready to submit.

### Skills

A visual manager for the skills in `~/.claude/skills`. Browse what's installed, edit any skill's files right in the browser, install one from a git or zip URL — or just describe what you want and let a background Claude session write the skill for you.

![Skills view](docs/screenshots/skills.webp)

### Config

Edit your global Claude Code setup without hunting for dotfiles: `settings.json` as a friendly collapsible tree (or raw JSON), your global `CLAUDE.md` in a text editor, and the app's own preferences (display name, zip code for weather, greeting on/off, plan renewal day).

![Config view](docs/screenshots/config.webp)

### Themes

Three looks, cycled from the sidebar: two dark neon/vaporwave themes (pink/blue and crimson) and **aero** — a light, Frutiger-Aero-inspired theme with sky gradients, drifting clouds, and soap bubbles. The terminal stays dark in every theme.

![Aero theme](docs/screenshots/aero.webp)

## How it's built

| Piece | Choice |
|-------|--------|
| Server | [Bun](https://bun.sh) — TypeScript with no build step, native WebSockets |
| Frontend | Svelte 5 + Vite single-page app |
| Terminal | xterm.js, bridged to tmux over a WebSocket |
| Sessions | tmux (`brew install tmux` required) |
| Usage data | Anthropic's OAuth usage endpoint + [ccusage](https://github.com/ryoppippi/ccusage) for monthly totals |

## Running it

```bash
bun install
bun run build   # builds the web frontend
bun start       # serves on http://localhost:4553
```

For run-at-login, install a launchd LaunchAgent pointing at `bun server/index.ts` (this repo uses `com.fenn.claude-command` with `RunAtLoad` + `KeepAlive`).

## A note on security

This app can start terminal sessions that run real commands, so it binds to **127.0.0.1 only** and has no authentication — it is meant for a single-user machine and must never be exposed to a network. (Optional Tailscale Serve support exists for reaching it from your own devices over your tailnet.)

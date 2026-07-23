# Agent Chat — Status & Handoff

_Last updated: 2026-07-21. The Claude driver shipped and is running in production
(launchd instance restarted onto this code). **Everything is uncommitted on main.**_

## What exists

A per-project **Terminal / Chat** toggle in the project view. Chat sessions drive
Claude programmatically via `@anthropic-ai/claude-agent-sdk` (subscription OAuth,
one `claude` subprocess per active session) — separate from tmux sessions, with
their own tabs, persisted per project in localStorage.

Working end-to-end (all verified live in Sandbox + headless Chrome, zero console
errors): streamed replies, thinking collapsibles, expandable tool cards, subagent
grouping by `parent_tool_use_id`, approval cards (Allow / Always allow /
Deny-with-message), AskUserQuestion as option buttons (multiSelect + free-text),
mid-session model/effort/mode switching, interrupt, mid-run message queueing,
session resume across server restarts (client resyncs via seq), usage/branch/cost
header strip, all three themes.

## File map

| Area | Files |
|---|---|
| Spec (original) | `docs/AGENT_CHAT_PLAN.md` |
| Server slice | `server/chat/{driver,claude,sessions,routes,ws}.ts` — driver.ts is the harness seam for a future Codex impl |
| WS wiring + PORT env | `server/index.ts` (`/ws/chat/:id` beside `/ws/session/:id`; `PORT` env override) |
| Frontend | `web/src/features/project/chat/*.svelte` (11 components), `web/src/stores/chat.svelte.ts`, `web/src/types/chat.ts`, `web/src/app/styles/chat.css` |
| Store files | `~/.config/harnessdeck/chat-sessions.json` (port 4553); other ports get `chat-sessions-<port>.json` |

## Locked decisions (do not re-litigate without cause)

- **Permissions mirror interactive Claude Code**: the user's real `~/.claude`
  settings load normally; allowlisted tools auto-run without prompting; the
  `canUseTool` callback fires only for genuinely-unresolved tools. An earlier
  `ask: ["Bash(*)"]` settings injection was removed — it lived in the flag layer
  above session scope and made "Always allow" a no-op.
- **`canBypassPermissions` is a per-session capability fixed at creation.** The
  SDK cannot add `allowDangerouslySkipPermissions` to a running session, so only
  sessions *created* in skip-approvals mode may switch back into it later. The
  launch flag is keyed off the persisted capability (not current mode) so this
  survives restarts.
- **AskUserQuestion** arrives via `canUseTool` on SDK 0.3.217; the
  `onUserDialog` (`ask_user_question` dialog kind) handler is wired as
  forward-compat for when the CLI moves it to the dialog channel.
- **Answers wire format**: arrays per question on our WS protocol; comma-joined
  only at the SDK boundary (that's the SDK's own documented contract).
- **`setChatOptions` mutates state only after the SDK call succeeds**; SDK
  rejections surface as an error event in the feed, never unhandled.
- **Project validation**: rejects `""`/`"."`/`".."`, realpaths BOTH the project
  and `~/Developer` (symlink-safe), parent must equal DEV_DIR. Matters because
  the server is tailnet-exposed.
- **`.chat-feed>*{flex-shrink:0}`** is load-bearing: cards with
  `overflow:hidden` in the scrolling flex column otherwise collapse to 2px once
  content overflows (flexbox auto-min-size rule).

## Review history (all green)

gpt-5.6-sol implemented (2 rounds); Opus reviewed 3× (11 findings round 1, 2 new
round 2, green round 3); UI review by Opus on 16 real screenshots → green-with-
polish, all should-fix + polish items applied and DOM-verified (de-natived
selects, DENIED in `--bad` not `--ok`, de-jargoned copy, "skip approvals" label,
header spacing, bare "–" placeholder, single-field tool input suppressed).
Screenshot evidence lived in a session scratchpad (ephemeral) — regenerate via
headless Chrome :9222 + puppeteer-core if needed (codex's built-in browser
backends don't work on this machine).

## Open items

1. **Not committed.** Working tree on main carries the whole feature.
2. **Safari untested** — all verification was headless Chrome; no clipboard or
   exotic APIs used, but give it a real WebKit pass.
3. **Codex driver (next phase)**: implement `ChatDriver` over `codex app-server`
   (stdio JSONL JSON-RPC; generate types via `codex app-server generate-ts`;
   wire quirk: `jsonrpc` field omitted). Bonus once a persistent app-server
   exists: replace rollout-JSONL usage parsing (`server/usage/codex-usage.ts`)
   with `account/rateLimits/read`, JWT plan-parsing with `account/read`, and the
   config.toml comment-toggling with `config/value/write`. Full research is in
   Claude's memory (`agent-chat-interface-research.md`).
4. Deferred taste-notes from UI review (optional): pulsing dot on LIVE; eyeball
   subagent-card nesting depth with real heavy content.

## Dev workflow

`PORT=4599 bun server/index.ts` for a dev instance beside production (4553,
launchd `com.fenn.claude-command`, restart via `launchctl kickstart -k`).
Note: `bun run build` swaps `web/dist` under the *live* prod server — restart
prod promptly after building or its UI and API drift apart. Live chat tests only
against `~/Developer/Sandbox`.

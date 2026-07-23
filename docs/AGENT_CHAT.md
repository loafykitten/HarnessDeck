# Agent Chat — Status & Handoff

_Last updated: 2026-07-22. Claude chat is running in production; the Codex driver
is implemented and verified on the isolated dev instance. **Everything is
uncommitted on main.**_

## What exists

A per-project **Terminal / Chat** toggle in the project view. Chat sessions drive
Claude programmatically via `@anthropic-ai/claude-agent-sdk`, or Codex via
`codex app-server` (subscription auth; one harness subprocess per active session)
— separate from tmux sessions, with their own tabs, persisted per project in
localStorage.

Claude is working end-to-end (verified live in Sandbox + headless Chrome, zero
console errors): streamed replies, thinking collapsibles, expandable tool cards, subagent
grouping by `parent_tool_use_id`, approval cards (Allow / Always allow /
Deny-with-message), AskUserQuestion as option buttons (multiSelect + free-text),
mid-session model/effort/mode switching, interrupt, mid-run message queueing,
session resume across server restarts (client resyncs via seq), usage/branch/cost
header strip, all three themes. Codex adds streamed replies, reasoning, tool and
command cards, approval round trips, interrupt, queued turns, per-turn option
changes, and persisted `thread/resume` continuity.

## File map

| Area | Files |
|---|---|
| Spec (original) | `docs/AGENT_CHAT_PLAN.md` |
| Server slice | `server/chat/{driver,claude,codex,options,sessions,routes,ws}.ts`; generated Codex bindings live in `server/chat/codex-protocol/` |
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
- **Codex permission modes map to app-server policy, not Claude mode names:**

  | UI mode | Codex sandbox | Codex approval policy |
  |---|---|---|
  | `default` | `workspace-write` | `untrusted` |
  | `plan` | `read-only` | `untrusted` |
  | `acceptEdits` | `workspace-write` | `on-request` |
  | `bypassPermissions` | `danger-full-access` | `never` |

  `untrusted` is the app-server's interactive default. `acceptEdits` lowers
  friction to `on-request`; this protocol version has no `on-failure` value.
  Bypass remains available only to sessions created with that capability.
- **Codex picker values are version-pinned to the generated 0.145.0 catalog:**
  models `default`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`; efforts
  `low`, `medium`, `high`, `xhigh`, `max`, `ultra`. `default` resolves through
  app-server's current default model. The driver clamps an unsupported effort to
  the model's highest supported one at turn start (gpt-5.6-luna has no `ultra`),
  using the `model/list` catalog fetched at session init.
- **Turn lifecycle is guarded against out-of-order arrival**: `turn/start`'s RPC
  response, `turn/started`, and `turn/completed` can land in one stdout chunk,
  so the awaited response resolves *after* the notifications. A `completedTurns`
  set keeps a finished turn's id from being resurrected into `activeTurnId`
  (which would deadlock the session permanently). Don't simplify this away.
- **A dead agent process doesn't kill the tab**: drivers set `handle.dead` when
  the subprocess exits; the registry starts a fresh handle (resuming via the
  persisted continuation id) on the next message.
- **`send()` during a pending approval must not emit `working`** — the store
  interprets leaving `waiting` as "requests answered" and hides Allow/Deny on
  still-open approval cards. Both drivers guard this.
- **Codex deny reasons only reach the wire on the legacy approval channel**
  (`ReviewDecision.denied.rejection`); the v2 request-approval responses have no
  message field, so the typed deny-reason is dropped there by protocol design.

## Review history (all green)

gpt-5.6-sol implemented (2 rounds); Opus reviewed 3× (11 findings round 1, 2 new
round 2, green round 3); UI review by Opus on 16 real screenshots → green-with-
polish, all should-fix + polish items applied and DOM-verified (de-natived
selects, DENIED in `--bad` not `--ok`, de-jargoned copy, "skip approvals" label,
header spacing, bare "–" placeholder, single-field tool input suppressed).
Screenshot evidence lived in a session scratchpad (ephemeral) — regenerate via
headless Chrome :9222 + puppeteer-core if needed (codex's built-in browser
backends don't work on this machine).

**Codex driver round (2026-07-22)**: gpt-5.6-sol implemented against generated
protocol types + a live `model/list` probe; opus-4.8 (high) adversarial review
found 1 critical (fast-turn `activeTurnId` resurrection deadlock), 4 major
(`setOptions` undefined-merge silently downgrading plan→workspace-write, dead
handle after app-server crash, poison-queue resend after failed `turn/start`,
send-during-approval hiding Allow/Deny — that last one shared with the claude
driver), 4 minor (interrupt fallback, `configWarning` shape, dropped deny
reason, ws set_options batch abort) — all fixed by Claude, plus a
duplicate-error-card bug the screenshot pass surfaced (error notification and
failed `turn/completed` both reported one failure). Protocol shapes, bypass
gating, and project validation verified clean. UI screenshot pass: form,
pickers, header, themes, claude regression all pass, zero console errors.

**Post-quota retest + WebKit pass (2026-07-23)**: after Codex moved to API-key
auth, the full live retest went green over the WS protocol (back-to-back fast
tool-less turns — deadlock regression clean; approval allow ran the command,
deny-with-message blocked it; effort=ultra on gpt-5.6-luna clamped instead of
erroring; zero error events). WebKit pass done via Playwright's WebKit engine,
headless (a real-Safari computer-use run wedged against the lock screen when
the lid closed — don't schedule GUI-automation runs unattended): chat layout
(no flex-collapse), backlog render, tool-card expand, and a live approval
round trip all pass with zero console errors; real Safari verified the
dashboard render before the run wedged. The pass caught one bug: codex replies
were labeled "Claude" (hardcoded in FeedEntry/ChatFeed) — fixed, labels are
harness-aware now.

## Open items

1. **Usage-RPC migration (separate pass)**: replace rollout-JSONL usage parsing
   (`server/usage/codex-usage.ts`) with `account/rateLimits/read`, JWT
   plan-parsing with `account/read`, and the config.toml comment-toggling with
   `config/value/write`. Deliberately out of scope for chat.
2. Deferred taste-notes from UI review (optional): pulsing dot on LIVE; eyeball
   subagent-card nesting depth with real heavy content.

## Dev workflow

`PORT=4599 bun server/index.ts` for a dev instance beside production (4553,
launchd `com.fenn.claude-command`, restart via `launchctl kickstart -k`).
Note: `bun run build` swaps `web/dist` under the *live* prod server — restart
prod promptly after building or its UI and API drift apart. Live chat tests only
against `~/Developer/Sandbox`.

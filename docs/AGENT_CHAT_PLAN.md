# Agent Chat Interface — Plan

> **Status: shipped 2026-07-21.** This is the original build spec; for current
> state, locked decisions, and open items see `docs/AGENT_CHAT.md`.

A toggleable chat view that replaces the terminal column inside the project view,
driving harnesses programmatically instead of rendering a tmux PTY. The terminal
path is untouched; chat is additive and per-project toggleable.

**This iteration: Claude driver only** (via `@anthropic-ai/claude-agent-sdk`), with
a clean driver seam so a Codex `app-server` driver can slot in later. The Codex
option appears in the UI but is disabled ("soon").

## Architecture

```
web (Svelte 5)  ── REST /api/chat/*  ──  server/chat/routes.ts
                ── WS  /ws/chat/:id  ──  server/chat/ws.ts
                                          └─ server/chat/sessions.ts  (registry)
                                              └─ server/chat/claude.ts (ChatDriver impl)
                                                  └─ @anthropic-ai/claude-agent-sdk → spawns `claude` subprocess
```

Chat sessions are **not** tmux sessions. They have their own ids (`chat-<uuid>`),
their own tabs, and their own lifecycle.

## Server

### `server/chat/driver.ts` — the harness seam

```ts
interface ChatDriver {
  start(opts: ChatStartOptions): ChatHandle;   // new or resumed session
}
interface ChatHandle {
  send(text: string): void;                    // push a user message
  respondPermission(id: string, res: PermissionResponse): void;
  respondQuestion(id: string, res: QuestionResponse): void;
  setOptions(opts: Partial<ChatOptions>): Promise<void>;  // model/effort/permissionMode
  interrupt(): Promise<void>;
  stop(): Promise<void>;                       // end subprocess, keep transcript
  events: AsyncIterable<ChatEvent> | (cb: (e: ChatEvent) => void) => void; // implementer's choice, pick one and keep it simple
}
```

Only `claude.ts` implements it now. Keep the interface free of Claude-specific
types so a codex driver fits later.

### `server/chat/claude.ts`

- Wraps `query()` from `@anthropic-ai/claude-agent-sdk` (add to **root** package.json;
  server imports it). **Read the installed package's `.d.ts` to confirm exact option
  and message-type names before coding against them** — the notes below are
  directional, not gospel.
- Streaming input mode: `prompt` is an AsyncIterable fed by an internal queue so
  `send()` works mid-run. `includePartialMessages: true` for token deltas.
- `cwd` = the project directory. `resume` with a stored SDK session id when
  reattaching. Capture the SDK session id from the `system`/`init` message.
- `canUseTool` bridges to the UI: create a pending request with a uuid, emit a
  `permission_request` event, return the promise; resolve when
  `respondPermission()` arrives. `AskUserQuestion` tool calls take the same path
  but emit `question_request` (render as options, return updatedInput with
  answers). Pending requests survive WS reconnects (re-emitted on attach).
- Map SDK messages → `ChatEvent`s (see protocol below). Track
  `parent_tool_use_id` so the UI can group subagent activity.
- On `result`: emit usage/cost. Status derivation: `working` while a turn runs,
  `waiting` while a permission/question is pending, `idle` otherwise.

### `server/chat/sessions.ts`

- In-memory `Map<string, ChatSession>` (id, project, name, harness, model,
  effort, permissionMode, sdkSessionId, status, created, lastActivity).
- Persist lightweight metadata to `~/.config/harnessdeck/chat-sessions.json`
  (same dir as usage-cache) so tabs survive server restarts; live subprocesses
  do not survive restarts — reattach lazily via `resume` on next message.
- Ring buffer of recent events per session (say 500) so a reconnecting/late
  client gets backlog via the `init` message. Transcript-perfect replay is not
  required for MVP.

### `server/chat/routes.ts` + `ws.ts`

- `GET /api/chat/sessions?project=` — list; `POST /api/chat/sessions` — create
  `{project, name, harness, model, effort, permissionMode}`; `DELETE
  /api/chat/sessions/:id` — stop + remove.
- WS `/ws/chat/:id` — register in `server/index.ts` alongside the terminal WS
  (extend `WsData` or discriminate on path; keep the terminal path untouched).
- Also change `const PORT = 4553` to `Number(process.env.PORT) || 4553` so a dev
  instance can run beside the launchd one.

### WS protocol (mirror types in `web/src/types/chat.ts`)

Server → client (all carry `seq` for backlog dedup):
- `init { session, backlog: ChatEvent[] }`
- `delta { kind: "text" | "thinking", text, parentToolUseId? }`
- `block { role, content, parentToolUseId? }` (completed message blocks)
- `tool { phase: "start" | "end", id, name, input?, result?, isError?, parentToolUseId? }`
- `permission_request { id, toolName, input, suggestions? }`
- `question_request { id, questions }`
- `status { status: "working" | "waiting" | "idle" }`
- `result { costUsd, usage, durationMs }`
- `error { message }`

Client → server:
- `user_message { text }`
- `permission_response { id, behavior: "allow" | "deny", updatedInput?, always?, message? }`
- `question_response { id, answers }`
- `set_options { model?, effort?, permissionMode? }`
- `interrupt {}`

## Frontend

### Toggle

In `ProjectView.svelte`, the right column (`.term-col`) gains a small
Terminal / Chat mode switch (segmented control in the card header area, glass
styling). Persist choice per project in localStorage. Terminal instances stay
mounted exactly as today when in terminal mode; chat mode swaps the column for
`Chat.svelte`.

### `web/src/features/project/chat/` components

- **Chat.svelte** — session tabs (same visual language as terminal tabs, chat
  sessions only), new-chat form: name, agent picker (claude enabled, codex
  disabled with a "soon" hint), model (`default | fable | opus | sonnet | haiku`),
  effort (`low…max`), mode (`default | plan | acceptEdits | bypassPermissions`).
- **ChatHeader** — minimal strip: 5h/weekly bars reusing `app.usage` data
  (compact — bars + %, no dashboard chrome), branch pill from the project's git
  info already in the store, session cost-so-far.
- **ChatFeed** — message list. Streaming assistant text accumulates from deltas.
  Lightweight hand-rolled markdown: fenced code blocks, inline code, bold —
  no new deps. Thinking renders as a dimmed collapsible. Tool calls render as
  chips (name + one-line input summary, e.g. the Bash command or file path),
  expandable to show input/result. Subagent activity (non-null
  `parentToolUseId`) groups into a collapsible "subagent" card with a
  running/done state.
- **Approval card** — inline in the feed: tool name, pretty-printed input,
  Allow / Always allow / Deny (deny reveals optional message input).
- **Question card** — AskUserQuestion options as buttons, multiSelect support,
  free-text "Other".
- **Composer** — textarea (Shift+Enter newline, Enter send), disabled-state
  awareness, interrupt button while working, inline pickers for model/effort/
  mode that call `set_options` mid-session.

### Store & plumbing

- `web/src/stores/chat.svelte.ts` — per-session rune state (feed, status,
  pending requests, options), WS lifecycle copying the patterns in
  `Terminal.svelte` (reconnect w/ backoff, 30s ping, suspend hidden tabs).
- Extend `web/src/lib/api.ts` with the chat endpoints.
- Status changes feed the existing chime pattern (`working`→`waiting` off-screen
  ⇒ question sound; `working`→`idle` ⇒ done sound) — mirror what
  `state.svelte.ts` does for terminal sessions.

### Styling

`.glass` / `.glow` primitives and tokens from `web/src/app/styles/` — match the
existing look (see `project.css`, `chips.css`; harness badge colors already
exist). New styles in `web/src/app/styles/chat.css`, imported like the others.
All three themes must look right.

## Out of scope (this iteration)

Codex driver; slash commands; transcript-perfect history restore; markdown
tables/images; artifact chips; file-tree integration; mobile layout beyond not
breaking `responsive.css`.

## Verification

1. `cd web && bun run check` — clean.
2. `bun run build` — clean; boot `PORT=4599 bun server/index.ts` beside the
   launchd instance (which owns 4553 — do not touch it).
3. Smoke test against the **Sandbox** project (`~/Developer/Sandbox`) only:
   create a chat session (model sonnet, effort low), send a trivial prompt,
   confirm streamed reply, a tool-permission round trip (e.g. ask it to run
   `echo hi` in default mode → approval card → allow → result), and reattach
   after killing/restarting the dev server.
```

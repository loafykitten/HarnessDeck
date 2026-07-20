# Harnesses — how they're modeled, and how to add one

HarnessDeck drives multiple coding-agent CLIs ("harnesses"). Today that's
**Claude Code** (`claude`) and **Codex CLI** (`codex`). This doc is the
checklist for wiring in the next one.

## The model

A harness is a CLI agent that:

- runs interactively in a tmux session inside a project directory,
- has a global **skills** directory of `SKILL.md` folders,
- has a global **instructions** markdown file (`CLAUDE.md` / `AGENTS.md`),
- has a **settings** file (JSON or TOML),
- and (optionally) has **usage stats** worth showing on the dashboard.

Everything the app knows about a harness lives in one registry:
**`server/harnesses.ts`** — id, label, binary, skills dir, instructions
path, settings path/format, and the two regexes that classify a visible
tmux pane as *working* (spinner/timer on screen) or *waiting* (question /
approval UI on screen). The frontend never hardcodes this; it fetches
`GET /api/harnesses` at startup (`app.harnesses` in
`web/src/lib/state.svelte.ts`).

Skills are identified by **name across harnesses**: `~/.claude/skills/foo`
and `~/.codex/skills/foo` are one skill "owned" by both. Reads come from the
first owner in registry order; edits are written to **every** owner so shared
skills can't drift; "Sync to X" copies the whole folder into another
harness's skills dir.

tmux session ids encode the harness as a suffix segment:
`cc-<project>--<name>` is a Claude session (the historical two-segment form,
kept so pre-rename sessions still parse), and `cc-<project>--<name>--codex`
is a Codex one. Sanitization collapses `-` runs, so `--` can never occur
inside a project or session name and the split is unambiguous. The `cc-`
prefix likewise predates the rename — changing it would orphan running
sessions, so don't.

## Checklist: adding harness `foo`

### 1. Registry (required — most things light up from this alone)

Add an entry to `HARNESSES` in `server/harnesses.ts`:

- `id`, `label`
- `bin` — absolute path if `Bun.which("foo")` can miss it under launchd
- `skillsDir`, `mdPath`/`mdLabel`, `settingsPath`/`settingsLabel`/`settingsFormat`
- `working`/`waiting` regexes — run the CLI in tmux, `tmux capture-pane -p`,
  and write patterns that match its spinner line and its question/approval UI
  (match the *option list*, never the always-present input prompt)

Add the id to the `HarnessId` union there, and mirror it in
`web/src/lib/api.ts` (`HarnessId` type) plus the `DEFAULT_HARNESSES`
fallback in `web/src/lib/state.svelte.ts`.

This alone gives you: session creation with the harness selector +
Shift+Tab cycling in the Projects view, tab/status badges, skills
ownership/filter/sync/multi-write, and Config-view cycling of the settings
file and instructions markdown. `settingsFormat: "json"` gets the collapsible
form editor; anything else gets the raw editor.

### 2. Usage stats (optional, per-harness by nature)

There is no generic usage interface — every vendor exposes usage
differently — so this part is bespoke:

- Add a `server/foo.ts` modeled on `server/codex.ts`: produce a
  `MonthUsage` (the shape `server/usage.ts` exports — daily tokens/cost,
  usually via `bunx ccusage foo daily --json` if ccusage supports the
  agent) and whatever rate-limit/plan info exists. If the harness has dual
  auth, follow `getCodexSpend`: classify each session's rollout by the auth
  mode it ran under and report per-mode monthly tokens/cost separately
  (API spend is real money; subscription cost is API-equivalent value).
- Surface it in the `/api/usage` handler in `server/index.ts` (add a field
  next to `codex:`), keep it `Promise.allSettled`-tolerant, and give it a
  60s cache + serve-stale-on-error like the others.
- Add a card to `web/src/components/Dashboard.svelte` (the Codex card is
  the template) and keep-last-good merging in `refreshUsage` in
  `state.svelte.ts`.

### 3. Auth/provider toggles (only if the harness has dual auth)

Codex's API-key ⇄ ChatGPT-OAuth switch works by commenting/uncommenting the
top-level `model_provider` line in `~/.codex/config.toml`
(`server/codex.ts: getCodexMode/setCodexMode`, `PUT /api/codex/mode`). If a
new harness has an equivalent dual-auth story, follow that pattern: detect
the mode by reading the config, toggle by making the smallest possible
byte-preserving edit, and expose GET/PUT endpoints the dashboard toggle and
Config view share.

### 4. Things that deliberately stay Claude-only

- The greeting whimsy line and the plan/renewal card (Anthropic OAuth).
- The updater chip (`server/updates.ts` runs `claude update`).
- Skill **generation** (`claude -p` scaffolds; new skills land in the
  default harness's dir — sync them over afterwards). Install-from-URL
  likewise targets the default harness.

If a new harness should participate in any of these, generalize the module
rather than forking it.

### 5. Colors

Harness badge colors live in `web/src/app.css` (`.hx.claude`, `.hx.codex`).
Give `foo` a `.hx.foo` rule or it renders in the neutral dim ink.

## File map

| Concern | File |
|---|---|
| Registry (single source of truth) | `server/harnesses.ts` |
| Sessions/tmux + status regex use | `server/sessions.ts` |
| Skills multi-harness ownership | `server/skills.ts` |
| Settings + instructions IO | `server/config.ts` |
| Codex usage + auth toggle | `server/codex.ts` |
| Claude usage | `server/usage.ts` |
| Routes | `server/index.ts` |
| Frontend types + API client | `web/src/lib/api.ts` |
| Harness list in app state | `web/src/lib/state.svelte.ts` |
| Dashboard usage cards | `web/src/components/Dashboard.svelte` |
| Session harness picker | `web/src/components/ProjectView.svelte` |
| Skills filter/sync/badges | `web/src/components/SkillsView.svelte` |
| Config harness cycling | `web/src/components/ConfigView.svelte` |
| Badge colors | `web/src/app.css` |

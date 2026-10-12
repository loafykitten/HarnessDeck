import { join } from "node:path";
import { CLAUDE_HOME, CODEX_HOME, HOME } from "../paths";

/** The harness registry: every agent CLI HarnessDeck can drive.
    Adding a harness = adding an entry here plus the per-harness bits listed
    in docs/HARNESSES.md (usage stats, status regexes are here; the frontend
    reads this registry via GET /api/harnesses). */

export type HarnessId = "claude" | "codex";

export interface Harness {
  id: HarnessId;
  label: string;
  /** Resolved at startup by harnessBin(); see there. */
  bin: string;
  /** Commands used to resume a conversation after restoring a tmux session. */
  resumeLast: string;
  resumePick: string;
  skillsDir: string;
  /** Global instructions file (CLAUDE.md / AGENTS.md). */
  mdPath: string;
  mdLabel: string;
  settingsPath: string;
  settingsLabel: string;
  settingsFormat: "json" | "toml";
  /** Classify a tmux pane tail: spinner/timer → working, question UI → waiting. */
  working: RegExp;
  waiting: RegExp;
}

/** The harness CLI to run. PATH first — npm-global and Homebrew installs
    live there — then the native installers' ~/.local/bin, which a minimal
    launchd PATH can lack. Neither found: the bare name, left to a later PATH
    lookup (the tmux sessions' login shell has the user's full PATH). Callers
    that spawn on demand resolve per call, so an install or update while the
    server runs is picked up. */
export function harnessBin(id: HarnessId): string {
  return Bun.which(id) ?? Bun.which(id, { PATH: join(HOME, ".local", "bin") }) ?? id;
}

const claudeBin = harnessBin("claude");
const codexBin = harnessBin("codex");

export const HARNESSES: Record<HarnessId, Harness> = {
  claude: {
    id: "claude",
    label: "Claude",
    bin: claudeBin,
    resumeLast: `${claudeBin} --continue`,
    resumePick: `${claudeBin} --resume`,
    skillsDir: join(CLAUDE_HOME, "skills"),
    mdPath: join(CLAUDE_HOME, "CLAUDE.md"),
    mdLabel: "~/.claude/CLAUDE.md",
    settingsPath: join(CLAUDE_HOME, "settings.json"),
    settingsLabel: "~/.claude/settings.json",
    settingsFormat: "json",
    working: /… \(\d+m? ?\d*s ?·|esc to interrupt/,
    waiting: /❯ ?\d+[.)] |Do you want|Would you like to proceed|What should Claude do instead/,
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: codexBin,
    resumeLast: `${codexBin} resume --last`,
    resumePick: `${codexBin} resume`,
    skillsDir: join(CODEX_HOME, "skills"),
    mdPath: join(CODEX_HOME, "AGENTS.md"),
    mdLabel: "~/.codex/AGENTS.md",
    settingsPath: join(CODEX_HOME, "config.toml"),
    settingsLabel: "~/.codex/config.toml",
    settingsFormat: "toml",
    working: /[Ee]sc to interrupt|Working \(\d/,
    waiting: /[❯›] ?\d+[.)] |Allow .{0,60}\?|Approval (?:needed|required)|Do you want|Would you like to/,
  },
};

export const HARNESS_IDS = Object.keys(HARNESSES) as HarnessId[];
export const DEFAULT_HARNESS: HarnessId = "claude";

export function isHarnessId(s: unknown): s is HarnessId {
  return typeof s === "string" && s in HARNESSES;
}

/** What the frontend needs to render harness pickers — no paths, no regexes. */
export function harnessMeta() {
  return HARNESS_IDS.map(id => {
    const h = HARNESSES[id];
    return {
      id,
      label: h.label,
      mdLabel: h.mdLabel,
      settingsLabel: h.settingsLabel,
      settingsFormat: h.settingsFormat,
    };
  });
}

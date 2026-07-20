import { homedir } from "node:os";
import { join } from "node:path";

/** The harness registry: every agent CLI HarnessDeck can drive.
    Adding a harness = adding an entry here plus the per-harness bits listed
    in docs/HARNESSES.md (usage stats, status regexes are here; the frontend
    reads this registry via GET /api/harnesses). */

export type HarnessId = "claude" | "codex";

export interface Harness {
  id: HarnessId;
  label: string;
  /** Absolute path preferred; falls back to PATH lookup in the login shell. */
  bin: string;
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

const home = homedir();

export const HARNESSES: Record<HarnessId, Harness> = {
  claude: {
    id: "claude",
    label: "Claude",
    bin: Bun.which("claude") ?? join(home, ".local", "bin", "claude"),
    skillsDir: join(home, ".claude", "skills"),
    mdPath: join(home, ".claude", "CLAUDE.md"),
    mdLabel: "~/.claude/CLAUDE.md",
    settingsPath: join(home, ".claude", "settings.json"),
    settingsLabel: "~/.claude/settings.json",
    settingsFormat: "json",
    working: /… \(\d+m? ?\d*s ?·|esc to interrupt/,
    waiting: /❯ ?\d+[.)] |Do you want|Would you like to proceed|What should Claude do instead/,
  },
  codex: {
    id: "codex",
    label: "Codex",
    bin: Bun.which("codex") ?? "codex",
    skillsDir: join(home, ".codex", "skills"),
    mdPath: join(home, ".codex", "AGENTS.md"),
    mdLabel: "~/.codex/AGENTS.md",
    settingsPath: join(home, ".codex", "config.toml"),
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

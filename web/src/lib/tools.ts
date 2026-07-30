export type ToolKind = "read" | "write" | "run" | "search" | "web" | "agent" | "todo" | "question" | "other";

/** Tool name → visual identity, shared by action rows and permission prompts. */
const KINDS: [RegExp, ToolKind, string][] = [
  [/^(Read|NotebookRead)$/i, "read", "▤"],
  [/^(Edit|MultiEdit|Write|NotebookEdit|ApplyPatch)$/i, "write", "✎"],
  [/^(Bash|BashOutput|KillShell)$/i, "run", "❯"],
  [/^(Glob|Grep)$/i, "search", "⌕"],
  [/^(WebFetch|WebSearch)$/i, "web", "◈"],
  [/^(Agent|Task)$/i, "agent", "✦"],
  [/^(TodoWrite|Task(Create|Update|List|Get))$/i, "todo", "☰"],
  [/^AskUserQuestion$/i, "question", "?"],
];

export function toolLook(name: string): { kind: ToolKind; glyph: string } {
  const match = KINDS.find(([pattern]) => pattern.test(name));
  return { kind: match?.[1] ?? "other", glyph: match?.[2] ?? "•" };
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

/** Absolute paths are mostly prefix; keep the end, which is the useful part. */
export function tailPath(value: string): string {
  const parts = value.split("/").filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : value;
}

import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { contentText } from "./claude";
import type { ChatHarness, DriverEvent } from "./driver";

/* Rebuilds a session's visible history from the harness's own on-disk record —
   the Claude project transcript or the Codex rollout file — after a server
   restart wipes the in-memory event feed. Emitted events mirror the shapes the
   live drivers produce so the client renders them identically. */

export interface RehydratedHistory {
  events: DriverEvent[];
  totalTokens: number;
}

export function rehydrateHistory(
  harness: ChatHarness,
  cwd: string,
  sdkSessionId: string,
): Promise<RehydratedHistory | null> {
  return harness === "claude" ? rehydrateClaude(cwd, sdkSessionId) : rehydrateCodex(sdkSessionId);
}

export function usageTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const values = usage as Record<string, unknown>;
  return ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]
    .reduce((total, key) => total + (typeof values[key] === "number" && Number.isFinite(values[key])
      ? Math.max(0, values[key])
      : 0), 0);
}

function* jsonLines(raw: string): Generator<Record<string, unknown>> {
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (value && typeof value === "object") yield value as Record<string, unknown>;
    } catch { /* torn write at the tail of a live file, or a byte-capped head */ }
  }
}

/** Transcripts grow without bound; cap what one boot is willing to hold in
    memory. Reading a tail can cut a line in half — jsonLines skips it. */
const MAX_SOURCE_BYTES = 16 * 1024 * 1024;

async function readCapped(path: string): Promise<string | null> {
  try {
    const file = Bun.file(path);
    const size = file.size;
    if (size === 0 || !(await file.exists())) return null;
    if (size <= MAX_SOURCE_BYTES) return await file.text();
    return await file.slice(size - MAX_SOURCE_BYTES, size).text();
  } catch {
    return null;
  }
}

/** Injected user records the live driver never surfaces as user messages —
    task notifications, system reminders, CLI command echoes. */
const SYNTHETIC_USER_PREFIXES = [
  "<task-notification>",
  "<system-reminder>",
  "<local-command",
  "<command-name>",
  "[Request interrupted",
  "Caveat: The messages below",
];

const isSyntheticUserText = (text: string): boolean =>
  SYNTHETIC_USER_PREFIXES.some(prefix => text.startsWith(prefix));

const claudeTranscriptPath = (cwd: string, sessionId: string): string =>
  join(homedir(), ".claude", "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${sessionId}.jsonl`);

async function rehydrateClaude(cwd: string, sessionId: string): Promise<RehydratedHistory | null> {
  const raw = await readCapped(claudeTranscriptPath(cwd, sessionId));
  if (raw === null) return null;
  const events: DriverEvent[] = [];
  const toolNames = new Map<string, string>();
  let totalTokens = 0;
  for (const entry of jsonLines(raw)) {
    if (entry.isSidechain === true || entry.isMeta === true) continue;
    const message = entry.message as Record<string, unknown> | undefined;
    if (!message) continue;
    if (entry.type === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content as Record<string, unknown>[]) {
        if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
          events.push({ type: "delta", kind: "thinking", text: block.thinking });
        } else if (block.type === "text" && typeof block.text === "string" && block.text) {
          events.push({ type: "block", role: "assistant", content: block.text });
        } else if (block.type === "tool_use" && typeof block.id === "string") {
          const name = typeof block.name === "string" ? block.name : "tool";
          toolNames.set(block.id, name);
          events.push({ type: "tool", phase: "start", id: block.id, name, input: block.input });
        }
      }
      const tokens = usageTokens(message.usage);
      if (tokens) totalTokens = tokens;
    } else if (entry.type === "user") {
      const content = message.content;
      if (typeof content === "string") {
        if (content && !isSyntheticUserText(content)) events.push({ type: "block", role: "user", content });
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts: string[] = [];
      let images = 0;
      for (const block of content as Record<string, unknown>[]) {
        if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
          events.push({
            type: "tool",
            phase: "end",
            id: block.tool_use_id,
            name: toolNames.get(block.tool_use_id) ?? "tool",
            result: contentText(block.content),
            isError: block.is_error === true,
          });
          toolNames.delete(block.tool_use_id);
        } else if (block.type === "text" && typeof block.text === "string" && !isSyntheticUserText(block.text)) {
          texts.push(block.text);
        } else if (block.type === "image") {
          images += 1;
        }
      }
      const text = texts.join("\n").trim();
      if (text) events.push({ type: "block", role: "user", content: text });
      else if (images) {
        events.push({
          type: "block",
          role: "user",
          content: images === 1 ? "Attached an image" : `Attached ${images} images`,
        });
      }
    }
  }
  return { events, totalTokens };
}

const CODEX_SESSIONS_DIR = join(homedir(), ".codex", "sessions");

/** sessions/<yyyy>/<mm>/<dd>/rollout-<ts>-<threadId>.jsonl; resumed threads
    append to the same file, so the newest match wins. */
async function findRolloutFile(threadId: string): Promise<string | null> {
  const suffix = `-${threadId}.jsonl`;
  const matches: { name: string; path: string }[] = [];
  for (const year of await readdir(CODEX_SESSIONS_DIR).catch(() => [] as string[])) {
    for (const month of await readdir(join(CODEX_SESSIONS_DIR, year)).catch(() => [] as string[])) {
      const dayDir = join(CODEX_SESSIONS_DIR, year, month);
      for (const day of await readdir(dayDir).catch(() => [] as string[])) {
        const files = await readdir(join(dayDir, day)).catch(() => [] as string[]);
        for (const name of files) {
          if (name.endsWith(suffix)) matches.push({ name, path: join(dayDir, day, name) });
        }
      }
    }
  }
  matches.sort((a, b) => a.name.localeCompare(b.name));
  return matches.at(-1)?.path ?? null;
}

const codexToolName = (name: unknown): string => {
  if (name === "exec_command" || name === "shell" || name === "local_shell") return "Bash";
  if (name === "apply_patch") return "ApplyPatch";
  return typeof name === "string" && name ? name : "tool";
};

const codexToolInput = (name: unknown, args: unknown): unknown => {
  if (typeof args !== "string" || !args) return args ?? undefined;
  try {
    const parsed: unknown = JSON.parse(args);
    if (codexToolName(name) === "Bash" && parsed && typeof parsed === "object"
      && typeof (parsed as Record<string, unknown>).cmd === "string") {
      return { command: (parsed as Record<string, unknown>).cmd };
    }
    return parsed;
  } catch {
    return args;
  }
};

/** Failure detection over the normalized output text: structured outputs are
    commonly arrays of input_text blocks, so flatten before matching. */
const codexOutputIsError = (output: unknown): boolean => {
  if (output && typeof output === "object" && !Array.isArray(output)
    && (output as Record<string, unknown>).success === false) {
    return true;
  }
  const text = typeof output === "string" ? output : contentText(output ?? "");
  const exitCode = text.match(/Process exited with code (\d+)/);
  if (exitCode) return exitCode[1] !== "0";
  return /^\S+ failed for /.test(text) || /^Script failed/.test(text);
};

async function rehydrateCodex(threadId: string): Promise<RehydratedHistory | null> {
  const file = await findRolloutFile(threadId);
  if (!file) return null;
  const raw = await readCapped(file);
  if (raw === null) return null;
  const events: DriverEvent[] = [];
  const callNames = new Map<string, string>();
  for (const entry of jsonLines(raw)) {
    const payload = entry.payload as Record<string, unknown> | undefined;
    if (!payload) continue;
    if (entry.type === "event_msg") {
      // user_message is the only reliable user-turn record (raw response_items
      // mix real messages with injected context); agent_message duplicates the
      // response_item copy, and agent_reasoning is the only readable thinking
      // source in API-key mode (reasoning items arrive with empty summaries).
      if (payload.type === "user_message" && typeof payload.message === "string" && payload.message) {
        events.push({ type: "block", role: "user", content: payload.message });
      } else if (payload.type === "agent_reasoning" && typeof payload.text === "string" && payload.text) {
        events.push({ type: "delta", kind: "thinking", text: payload.text });
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      const text = (payload.content as Record<string, unknown>[])
        .map(block => typeof block.text === "string" ? block.text : "")
        .filter(Boolean)
        .join("\n");
      if (text) events.push({ type: "block", role: "assistant", content: text });
    } else if ((payload.type === "function_call" || payload.type === "custom_tool_call")
      && typeof payload.call_id === "string") {
      const name = codexToolName(payload.name);
      callNames.set(payload.call_id, name);
      events.push({
        type: "tool",
        phase: "start",
        id: payload.call_id,
        name,
        input: codexToolInput(payload.name, payload.arguments ?? payload.input),
      });
    } else if ((payload.type === "function_call_output" || payload.type === "custom_tool_call_output")
      && typeof payload.call_id === "string") {
      events.push({
        type: "tool",
        phase: "end",
        id: payload.call_id,
        name: callNames.get(payload.call_id) ?? "tool",
        result: typeof payload.output === "string" ? payload.output : contentText(payload.output),
        isError: codexOutputIsError(payload.output),
      });
      callNames.delete(payload.call_id);
    }
  }
  return { events, totalTokens: 0 };
}

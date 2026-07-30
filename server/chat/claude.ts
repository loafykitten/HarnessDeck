import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import {
  query,
  type CanUseTool,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { AskUserQuestionOutput } from "@anthropic-ai/claude-agent-sdk/sdk-tools";
import type {
  ChatDriver,
  ClaudeChatEffort,
  ChatHandle,
  ChatOptions,
  ChatStartOptions,
  DriverEvent,
  PermissionResponse,
  QuestionResponse,
} from "./driver";
import { chatImageMediaType } from "./images";

class AsyncQueue<T> implements AsyncIterable<T> {
  private values: T[] = [];
  private waiters: ((value: IteratorResult<T>) => void)[] = [];
  private ended = false;

  push(value: T): void {
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else if (!this.ended) this.values.push(value);
  }

  end(): void {
    this.ended = true;
    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise(resolve => this.waiters.push(resolve));
      },
    };
  }
}

type PendingPermission = {
  kind: "permission";
  toolUseId: string;
  toolName: string;
  suggestions?: PermissionUpdate[];
  resolve: (result: PermissionResult) => void;
};
type PendingQuestion = {
  kind: "question";
  toolUseId: string;
  input: Record<string, unknown>;
  resolve: (result: PermissionResult) => void;
};

const parentId = (message: { parent_tool_use_id?: string | null }) =>
  message.parent_tool_use_id ?? undefined;

export const contentText = (content: unknown): string => {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return JSON.stringify(content) ?? String(content);
  return content.map(block => {
    if (typeof block === "string") return block;
    if (!block || typeof block !== "object") return String(block);
    const item = block as Record<string, unknown>;
    return typeof item.text === "string" ? item.text : JSON.stringify(item);
  }).join("\n");
};

const sdkQuestionAnswers = (answers: Record<string, string[]>): AskUserQuestionOutput["answers"] =>
  Object.fromEntries(Object.entries(answers).map(([question, values]) => [question, values.join(", ")]));

const chatDebug = (message: string): void => {
  if (process.env.HARNESSDECK_CHAT_DEBUG === "1") console.log(`[chat] ${message}`);
};

class ClaudeChatHandle implements ChatHandle {
  private input = new AsyncQueue<SDKUserMessage>();
  private listeners = new Set<(event: DriverEvent) => void>();
  private pending = new Map<string, PendingPermission | PendingQuestion>();
  private toolNames = new Map<string, string>();
  private sdk: Query;
  private stopped = false;
  private continuationId?: string;
  private interruptFallback: ReturnType<typeof setTimeout> | null = null;
  /** Tokens in the window as of the latest top-level API request. */
  private contextUsed: number | null = null;
  /** Window size from the latest result's modelUsage; carried across turns. */
  private contextWindow: number | null = null;

  constructor(private options: ChatStartOptions) {
    this.continuationId = options.continuationId;
    const canUseTool: CanUseTool = async (toolName, input, context) => {
      const id = randomUUID();
      return new Promise<PermissionResult>(resolve => {
        if (toolName === "AskUserQuestion") {
          // The CLI uses permission_ask_user_question here; leaving it undeclared falls back to
          // canUseTool with the full input. The old ask_user_question dialog kind does not exist,
          // so that path never fired (verified against the live CLI).
          const questions = Array.isArray(input.questions) ? input.questions : [];
          chatDebug("AskUserQuestion via canUseTool");
          this.pending.set(id, {
            kind: "question",
            toolUseId: context.toolUseID,
            input,
            resolve,
          });
          this.emit({ type: "question_request", id, questions: questions as never[] });
        } else {
          this.pending.set(id, {
            kind: "permission",
            toolUseId: context.toolUseID,
            toolName,
            suggestions: context.suggestions,
            resolve,
          });
          this.emit({ type: "permission_request", id, toolName, input, suggestions: context.suggestions });
        }
        this.emit({ type: "status", status: "waiting" });
        context.signal.addEventListener("abort", () => {
          if (!this.pending.delete(id)) return;
          resolve({ behavior: "deny", message: "Request interrupted", toolUseID: context.toolUseID });
          this.emit({ type: "request_resolved", id, outcome: "dismissed" });
        }, { once: true });
      });
    };

    this.sdk = query({
      prompt: this.input,
      options: {
        cwd: options.cwd,
        model: options.model === "default" ? undefined : options.model,
        effort: options.effort as ClaudeChatEffort,
        permissionMode: options.permissionMode,
        ...(options.canBypassPermissions || options.permissionMode === "bypassPermissions"
          ? { allowDangerouslySkipPermissions: true }
          : {}),
        includePartialMessages: true,
        forwardSubagentText: true,
        canUseTool,
        resume: options.continuationId,
      },
    });
    void this.consume();
  }

  onEvent(callback: (event: DriverEvent) => void): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  private emit(event: DriverEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  async send(text: string, imagePaths: string[] = []): Promise<void> {
    if (this.stopped) return;
    if (this.interruptFallback) {
      clearTimeout(this.interruptFallback);
      this.interruptFallback = null;
    }
    const content: Exclude<SDKUserMessage["message"]["content"], string> = [];
    if (text) content.push({ type: "text", text });
    for (const path of imagePaths) {
      content.push({
        type: "image",
        source: {
          type: "base64",
          media_type: chatImageMediaType(path),
          data: (await readFile(path)).toString("base64"),
        },
      });
    }
    // Carry the paste basenames so the feed can render the images inline.
    // They are unguessable ids and keep the absolute homedir path off the wire.
    const images = imagePaths.map(path => basename(path));
    this.emit({ type: "block", role: "user", content: text, images: images.length ? images : undefined });
    if (!this.pending.size) this.emit({ type: "status", status: "working" });
    this.input.push({
      type: "user",
      message: { role: "user", content },
      parent_tool_use_id: null,
      origin: { kind: "human" },
    });
  }

  respondPermission(id: string, response: PermissionResponse): void {
    const request = this.pending.get(id);
    if (!request || request.kind !== "permission") return;
    if (!this.pending.delete(id)) return;
    if (response.behavior === "allow") {
      const updatedPermissions: PermissionUpdate[] | undefined = response.always
        ? request.suggestions?.length
          ? request.suggestions
          : [{
            type: "addRules",
            rules: [{ toolName: request.toolName }],
            behavior: "allow",
            destination: "session",
          }]
        : undefined;
      request.resolve({
        behavior: "allow",
        updatedInput: response.updatedInput,
        updatedPermissions,
        toolUseID: request.toolUseId,
        decisionClassification: response.always ? "user_permanent" : "user_temporary",
      });
    } else {
      request.resolve({
        behavior: "deny",
        message: response.message || "User denied this tool call",
        toolUseID: request.toolUseId,
        decisionClassification: "user_reject",
      });
    }
    this.emit({
      type: "request_resolved",
      id,
      outcome: response.behavior === "deny" ? "denied" : response.always ? "always-allowed" : "allowed",
    });
    this.emit({ type: "status", status: this.pending.size ? "waiting" : "working" });
  }

  respondQuestion(id: string, response: QuestionResponse): void {
    const request = this.pending.get(id);
    if (!request || request.kind !== "question") return;
    if (!this.pending.delete(id)) return;
    request.resolve({
      behavior: "allow",
      updatedInput: { ...request.input, answers: sdkQuestionAnswers(response.answers) },
      toolUseID: request.toolUseId,
      decisionClassification: "user_temporary",
    });
    this.emit({ type: "request_resolved", id, outcome: "answered" });
    this.emit({ type: "status", status: this.pending.size ? "waiting" : "working" });
  }

  async setOptions(options: Partial<ChatOptions>): Promise<void> {
    if (options.model !== undefined) {
      await this.sdk.setModel(options.model === "default" ? undefined : options.model);
    }
    if (options.effort !== undefined) {
      await this.sdk.applyFlagSettings({ effortLevel: options.effort as ClaudeChatEffort });
    }
    if (options.permissionMode !== undefined) await this.sdk.setPermissionMode(options.permissionMode);
    this.options = { ...this.options, ...options };
  }

  async interrupt(): Promise<void> {
    await this.sdk.interrupt();
    if (this.interruptFallback) clearTimeout(this.interruptFallback);
    this.interruptFallback = setTimeout(() => {
      this.interruptFallback = null;
      if (!this.stopped) this.emit({ type: "status", status: "idle" });
    }, 2_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    if (this.interruptFallback) clearTimeout(this.interruptFallback);
    this.interruptFallback = null;
    this.input.end();
    for (const [id, request] of this.pending) {
      if (!this.pending.delete(id)) continue;
      request.resolve({ behavior: "deny", message: "Session stopped", toolUseID: request.toolUseId });
      this.emit({ type: "request_resolved", id, outcome: "dismissed" });
    }
    this.sdk.close();
    this.emit({ type: "status", status: "idle" });
  }

  /** Ask the CLI for its own context breakdown to seed used/window before the
      first turn completes. Best-effort: the control request is experimental,
      and the meter falls back to per-request usage and result data. */
  private async seedContext(): Promise<void> {
    try {
      const usage = await this.sdk.getContextUsage();
      if (this.stopped) return;
      const window = usage.rawMaxTokens > 0 ? usage.rawMaxTokens : usage.maxTokens > 0 ? usage.maxTokens : null;
      if (window !== null) this.contextWindow = window;
      // An assistant response may have landed while the request was in flight;
      // its per-request figure is newer, so only fill the gap.
      if (this.contextUsed === null && Number.isFinite(usage.totalTokens) && usage.totalTokens >= 0) {
        this.contextUsed = usage.totalTokens;
      }
      if (this.contextUsed !== null) {
        this.emit({ type: "context", context: { used: this.contextUsed, window: this.contextWindow } });
      }
    } catch {
      // Older CLI or transport hiccup — the meter appears at the first result.
    }
  }

  private async consume(): Promise<void> {
    try {
      for await (const message of this.sdk) this.handleMessage(message);
    } catch (error) {
      if (!this.stopped) {
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        this.emit({ type: "status", status: "idle" });
      }
    }
  }

  private handleMessage(message: SDKMessage): void {
    if ("session_id" in message && message.session_id && message.session_id !== this.continuationId) {
      this.continuationId = message.session_id;
      this.options.onContinuationId?.(message.session_id);
    }
    if (message.type === "system" && message.subtype === "init") {
      // Seed the meter before the first result: a resumed session already has
      // context, and the window size is otherwise unknown until a turn ends.
      void this.seedContext();
      return;
    }
    if (message.type === "stream_event") {
      const event = message.event as unknown as Record<string, unknown>;
      if (event.type !== "content_block_delta" || !event.delta || typeof event.delta !== "object") return;
      const delta = event.delta as Record<string, unknown>;
      const kind = delta.type === "thinking_delta" ? "thinking" : delta.type === "text_delta" ? "text" : null;
      if (kind && typeof delta.text === "string") {
        this.emit({ type: "delta", kind, text: delta.text, parentToolUseId: parentId(message) });
      } else if (kind === "thinking" && typeof delta.thinking === "string") {
        this.emit({ type: "delta", kind, text: delta.thinking, parentToolUseId: parentId(message) });
      }
      return;
    }
    if (message.type === "assistant") {
      // Each top-level assistant message is one API response whose usage counts
      // the full context of that request — the live occupancy. Subagent messages
      // (parent_tool_use_id set) run in their own windows and are skipped.
      if (parentId(message) === undefined) {
        const used = requestTokens(message.message.usage);
        if (used !== null) {
          this.contextUsed = used;
          this.emit({ type: "context", context: { used, window: this.contextWindow } });
        }
      }
      for (const block of message.message.content) {
        if (block.type === "text") {
          this.emit({ type: "block", role: "assistant", content: block.text, parentToolUseId: parentId(message) });
        } else if (block.type === "tool_use") {
          this.toolNames.set(block.id, block.name);
          this.emit({
            type: "tool",
            phase: "start",
            id: block.id,
            name: block.name,
            input: block.input,
            parentToolUseId: parentId(message),
          });
        }
      }
      if (message.error) this.emit({ type: "error", message: message.error });
      return;
    }
    if (message.type === "user" && Array.isArray(message.message.content)) {
      for (const block of message.message.content) {
        if (block.type !== "tool_result") continue;
        this.emit({
          type: "tool",
          phase: "end",
          id: block.tool_use_id,
          name: this.toolNames.get(block.tool_use_id) ?? "tool",
          result: contentText(block.content ?? message.tool_use_result),
          isError: block.is_error,
          parentToolUseId: parentId(message),
        });
        this.toolNames.delete(block.tool_use_id);
      }
      return;
    }
    if (message.type === "result") {
      if (this.interruptFallback) clearTimeout(this.interruptFallback);
      this.interruptFallback = null;
      const window = dominantWindow(message.modelUsage);
      if (window !== null) this.contextWindow = window;
      this.emit({
        type: "result",
        costUsd: message.total_cost_usd,
        usage: message.usage,
        durationMs: message.duration_ms,
        // NOT message.usage: the result usage accumulates every request in the
        // turn, so each one re-counts the whole context (cache reads included)
        // and a long turn reports several times the real occupancy.
        context: this.contextUsed !== null
          ? { used: this.contextUsed, window: this.contextWindow }
          : undefined,
      });
      if (message.subtype !== "success") {
        this.emit({ type: "error", message: message.errors.join("\n") || message.subtype });
      }
      this.emit({ type: "status", status: "idle" });
    }
  }
}

/** Tokens of a single API request's usage — the context that request occupied.
    Null when the message carries no usable usage (defensive: replayed or
    synthetic messages). */
function requestTokens(usage: unknown): number | null {
  if (!usage || typeof usage !== "object") return null;
  const values = usage as Record<string, unknown>;
  let total = 0;
  let seen = false;
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    const value = values[key];
    if (typeof value === "number" && Number.isFinite(value)) {
      total += Math.max(0, value);
      seen = true;
    }
  }
  return seen ? total : null;
}

/** Window size from the dominant model's usage entry (subagent models also
    appear in modelUsage; the main model has by far the most input). */
function dominantWindow(modelUsage: unknown): number | null {
  let window: number | null = null;
  let dominantInput = -1;
  if (modelUsage && typeof modelUsage === "object") {
    for (const entry of Object.values(modelUsage as Record<string, unknown>)) {
      if (!entry || typeof entry !== "object") continue;
      const model = entry as Record<string, unknown>;
      const input = typeof model.inputTokens === "number" ? model.inputTokens : 0;
      const cached = typeof model.cacheReadInputTokens === "number" ? model.cacheReadInputTokens : 0;
      if (input + cached > dominantInput && typeof model.contextWindow === "number" && model.contextWindow > 0) {
        dominantInput = input + cached;
        window = model.contextWindow;
      }
    }
  }
  return window;
}

export const claudeChatDriver: ChatDriver = {
  start: options => new ClaudeChatHandle(options),
};

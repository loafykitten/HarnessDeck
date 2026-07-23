import { randomUUID } from "node:crypto";
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

const contentText = (content: unknown): string => {
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

  send(text: string): void {
    if (this.stopped) return;
    if (this.interruptFallback) {
      clearTimeout(this.interruptFallback);
      this.interruptFallback = null;
    }
    this.emit({ type: "block", role: "user", content: text });
    if (!this.pending.size) this.emit({ type: "status", status: "working" });
    this.input.push({
      type: "user",
      message: { role: "user", content: text },
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
      this.emit({
        type: "result",
        costUsd: message.total_cost_usd,
        usage: message.usage,
        durationMs: message.duration_ms,
      });
      if (message.subtype !== "success") {
        this.emit({ type: "error", message: message.errors.join("\n") || message.subtype });
      }
      this.emit({ type: "status", status: "idle" });
    }
  }
}

export const claudeChatDriver: ChatDriver = {
  start: options => new ClaudeChatHandle(options),
};

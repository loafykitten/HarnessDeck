import { randomUUID } from "node:crypto";
import type {
  ClientNotification,
  ClientRequest,
  InitializeParams,
  InitializeResponse,
  ServerNotification,
  ServerRequest,
} from "./codex-protocol";
import type {
  AskForApproval,
  CommandExecutionRequestApprovalResponse,
  FileChangeRequestApprovalResponse,
  ModelListResponse,
  PermissionsRequestApprovalResponse,
  SandboxPolicy,
  ThreadItem,
  ThreadResumeParams,
  ThreadResumeResponse,
  ThreadStartParams,
  ThreadStartResponse,
  ThreadTokenUsage,
  TurnCompletedNotification,
  TurnInterruptResponse,
  TurnStartParams,
  TurnStartResponse,
} from "./codex-protocol/v2";
import type {
  ChatDriver,
  ChatHandle,
  ChatOptions,
  ChatPermissionMode,
  ChatStartOptions,
  DriverEvent,
  PermissionResponse,
  QuestionResponse,
} from "./driver";

type RpcError = { code: number; message: string; data?: unknown };
type RpcResponse = { id: string | number; result?: unknown; error?: RpcError };
type PendingRpc = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
};
type PendingApproval = {
  respond: (response: PermissionResponse) => void;
};

const chatDebug = (message: string): void => {
  if (process.env.HARNESSDECK_CHAT_DEBUG === "1") console.log(`[chat:codex] ${message}`);
};

const permissionOptions = (mode: ChatPermissionMode): {
  approvalPolicy: AskForApproval;
  sandboxMode: "read-only" | "workspace-write" | "danger-full-access";
} => {
  if (mode === "plan") return { approvalPolicy: "untrusted", sandboxMode: "read-only" };
  if (mode === "acceptEdits") return { approvalPolicy: "on-request", sandboxMode: "workspace-write" };
  if (mode === "bypassPermissions") return { approvalPolicy: "never", sandboxMode: "danger-full-access" };
  return { approvalPolicy: "untrusted", sandboxMode: "workspace-write" };
};

const sandboxPolicy = (mode: ChatPermissionMode, cwd: string): SandboxPolicy => {
  const { sandboxMode } = permissionOptions(mode);
  if (sandboxMode === "danger-full-access") return { type: "dangerFullAccess" };
  if (sandboxMode === "read-only") return { type: "readOnly", networkAccess: false };
  return {
    type: "workspaceWrite",
    writableRoots: [cwd],
    networkAccess: false,
    excludeTmpdirEnvVar: false,
    excludeSlashTmp: false,
  };
};

const toolDetails = (item: ThreadItem): {
  name: string;
  input: unknown;
  result: unknown;
  isError: boolean;
} | null => {
  if (item.type === "userMessage" || item.type === "agentMessage" || item.type === "reasoning") return null;
  if (item.type === "commandExecution") {
    return {
      name: "Bash",
      input: { command: item.command, cwd: item.cwd, actions: item.commandActions },
      result: {
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        durationMs: item.durationMs,
        status: item.status,
      },
      isError: item.status === "failed" || item.status === "declined"
        || (item.exitCode !== null && item.exitCode !== 0),
    };
  }
  if (item.type === "fileChange") {
    return {
      name: "ApplyPatch",
      input: { changes: item.changes },
      result: { changes: item.changes, status: item.status },
      isError: item.status === "failed" || item.status === "declined",
    };
  }
  if (item.type === "mcpToolCall") {
    return {
      name: item.tool,
      input: { server: item.server, arguments: item.arguments },
      result: item.error ?? item.result,
      isError: item.status === "failed" || item.error !== null,
    };
  }
  if (item.type === "dynamicToolCall") {
    return {
      name: item.tool,
      input: { namespace: item.namespace, arguments: item.arguments },
      result: item.contentItems,
      isError: item.status === "failed" || item.success === false,
    };
  }
  if (item.type === "webSearch") {
    return {
      name: "WebSearch",
      input: { query: item.query, action: item.action },
      result: item.results,
      isError: false,
    };
  }
  if (item.type === "imageView") {
    return { name: "ViewImage", input: { path: item.path }, result: item, isError: false };
  }
  if (item.type === "imageGeneration") {
    return { name: "ImageGeneration", input: item, result: item, isError: false };
  }
  if (item.type === "sleep") {
    return { name: "Sleep", input: item, result: item, isError: false };
  }
  if (item.type === "contextCompaction") {
    return { name: "ContextCompaction", input: {}, result: item, isError: false };
  }
  if (item.type === "plan") {
    return { name: "Plan", input: { text: item.text }, result: item.text, isError: false };
  }
  if (item.type === "hookPrompt") {
    return { name: "HookPrompt", input: item.fragments, result: item, isError: false };
  }
  if (item.type === "collabAgentToolCall") {
    return {
      name: String(item.tool),
      input: { prompt: item.prompt, model: item.model, receiverThreadIds: item.receiverThreadIds },
      result: item,
      isError: item.status === "failed",
    };
  }
  if (item.type === "subAgentActivity") {
    return { name: "SubAgentActivity", input: item, result: item, isError: false };
  }
  if (item.type === "enteredReviewMode" || item.type === "exitedReviewMode") {
    return { name: item.type, input: { review: item.review }, result: item, isError: false };
  }
  const unknownItem = item as unknown as { type: string; id: string };
  return {
    name: unknownItem.type,
    input: unknownItem,
    result: unknownItem,
    isError: false,
  };
};

class CodexChatHandle implements ChatHandle {
  private listeners = new Set<(event: DriverEvent) => void>();
  private pendingRpc = new Map<string | number, PendingRpc>();
  private pendingApprovals = new Map<string, PendingApproval>();
  private toolNames = new Map<string, string>();
  private reasoningItemsWithDelta = new Set<string>();
  private completedTurns = new Set<string>();
  private modelEfforts = new Map<string, string[]>();
  private lastErrorMessage: string | null = null;
  private interruptFallback: ReturnType<typeof setTimeout> | null = null;
  private queue: string[] = [];
  dead = false;
  private proc: Bun.PipedSubprocess;
  private requestId = 0;
  private stdoutBuffer = "";
  private stderrText = "";
  private stopped = false;
  private activeTurnId: string | null = null;
  private turnStartedAt = 0;
  private latestUsage: ThreadTokenUsage | null = null;
  private threadId: string | null = null;
  private defaultModel: string | null = null;
  private effectiveModel: string | null = null;
  private pumping = false;
  private ready: Promise<void>;

  constructor(private options: ChatStartOptions) {
    this.threadId = options.continuationId ?? null;
    this.proc = Bun.spawn(["codex", "app-server"], {
      cwd: options.cwd,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    void this.consumeStdout();
    void this.consumeStderr();
    void this.watchExit();
    this.ready = this.initialize();
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
    this.emit({ type: "block", role: "user", content: text });
    if (!this.pendingApprovals.size) this.emit({ type: "status", status: "working" });
    this.queue.push(text);
    void this.pump();
  }

  respondPermission(id: string, response: PermissionResponse): void {
    const approval = this.pendingApprovals.get(id);
    if (!approval) return;
    this.pendingApprovals.delete(id);
    approval.respond(response);
    this.emit({
      type: "status",
      status: this.pendingApprovals.size ? "waiting" : this.activeTurnId ? "working" : "idle",
    });
  }

  respondQuestion(_id: string, _response: QuestionResponse): void {
    // Codex app-server has no AskUserQuestion equivalent in this integration.
  }

  async setOptions(options: Partial<ChatOptions>): Promise<void> {
    if (options.model !== undefined) this.options.model = options.model;
    if (options.effort !== undefined) this.options.effort = options.effort;
    if (options.permissionMode !== undefined) this.options.permissionMode = options.permissionMode;
    if (!this.activeTurnId && this.queue.length) void this.pump();
  }

  async interrupt(): Promise<void> {
    this.queue.length = 0;
    this.denyPendingApprovals();
    const threadId = this.threadId;
    const turnId = this.activeTurnId;
    if (!threadId || !turnId) {
      if (!this.stopped) this.emit({ type: "status", status: "idle" });
      return;
    }
    await this.request<TurnInterruptResponse>("turn/interrupt", { threadId, turnId });
    if (this.interruptFallback) clearTimeout(this.interruptFallback);
    this.interruptFallback = setTimeout(() => {
      this.interruptFallback = null;
      if (this.stopped || !this.activeTurnId) return;
      this.activeTurnId = null;
      this.emit({ type: "status", status: "idle" });
    }, 2_000);
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.queue.length = 0;
    this.denyPendingApprovals();
    this.stopped = true;
    this.dead = true;
    if (this.interruptFallback) {
      clearTimeout(this.interruptFallback);
      this.interruptFallback = null;
    }
    for (const request of this.pendingRpc.values()) request.reject(new Error("Codex session stopped"));
    this.pendingRpc.clear();
    this.proc.stdin.end();
    this.proc.kill();
    await this.proc.exited;
    this.emit({ type: "status", status: "idle" });
  }

  private async initialize(): Promise<void> {
    const params: InitializeParams = {
      clientInfo: { name: "harnessdeck", title: "HarnessDeck", version: "1.0.0" },
      capabilities: null,
    };
    await this.request<InitializeResponse>("initialize", params);
    this.notify({ method: "initialized" });
    try {
      const models = await this.request<ModelListResponse>("model/list", { includeHidden: false });
      this.defaultModel = models.data.find(model => model.isDefault)?.model ?? null;
      for (const model of models.data) {
        this.modelEfforts.set(model.model, model.supportedReasoningEfforts.map(option => option.reasoningEffort));
      }
    } catch (error) {
      chatDebug(`model/list failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    const mapped = permissionOptions(this.options.permissionMode);
    if (this.threadId) {
      const params: ThreadResumeParams = {
        threadId: this.threadId,
        cwd: this.options.cwd,
        approvalPolicy: mapped.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: mapped.sandboxMode,
        model: this.options.model === "default" ? undefined : this.options.model,
      };
      const response = await this.request<ThreadResumeResponse>("thread/resume", params);
      this.acceptThread(response);
    } else {
      const params: ThreadStartParams = {
        cwd: this.options.cwd,
        approvalPolicy: mapped.approvalPolicy,
        approvalsReviewer: "user",
        sandbox: mapped.sandboxMode,
        model: this.options.model === "default" ? undefined : this.options.model,
      };
      const response = await this.request<ThreadStartResponse>("thread/start", params);
      this.acceptThread(response);
    }
  }

  private acceptThread(response: ThreadStartResponse | ThreadResumeResponse): void {
    this.threadId = response.thread.id;
    this.effectiveModel = response.model;
    this.options.onContinuationId?.(response.thread.id);
  }

  private effortFor(model: string | null): string {
    const effort = this.options.effort;
    const supported = model ? this.modelEfforts.get(model) : undefined;
    if (!supported?.length || supported.includes(effort)) return effort;
    const fallback = supported[supported.length - 1];
    chatDebug(`effort ${effort} unsupported on ${model}; using ${fallback}`);
    return fallback;
  }

  private async pump(): Promise<void> {
    if (this.pumping || this.stopped || this.activeTurnId || this.queue.length === 0) return;
    this.pumping = true;
    try {
      await this.ready;
      if (this.stopped || this.activeTurnId) return;
      const text = this.queue.shift();
      const threadId = this.threadId;
      if (!text || !threadId) return;
      const mapped = permissionOptions(this.options.permissionMode);
      const model = this.options.model === "default"
        ? this.defaultModel ?? this.effectiveModel
        : this.options.model;
      const params: TurnStartParams = {
        threadId,
        input: [{ type: "text", text, text_elements: [] }],
        cwd: this.options.cwd,
        approvalPolicy: mapped.approvalPolicy,
        approvalsReviewer: "user",
        sandboxPolicy: sandboxPolicy(this.options.permissionMode, this.options.cwd),
        model,
        effort: this.effortFor(model),
        summary: "auto",
      };
      this.turnStartedAt = Date.now();
      this.latestUsage = null;
      this.lastErrorMessage = null;
      const response = await this.request<TurnStartResponse>("turn/start", params);
      if (!this.completedTurns.has(response.turn.id)) this.activeTurnId = response.turn.id;
    } catch (error) {
      if (!this.stopped) {
        this.emit({ type: "error", message: error instanceof Error ? error.message : String(error) });
        this.emit({ type: "status", status: this.queue.length ? "working" : "idle" });
      }
    } finally {
      this.pumping = false;
      if (!this.stopped && !this.activeTurnId && this.queue.length) void this.pump();
    }
  }

  private request<T>(method: ClientRequest["method"], params: unknown): Promise<T> {
    if (this.stopped) return Promise.reject(new Error("Codex session stopped"));
    const id = ++this.requestId;
    const message = { id, method, params } as ClientRequest;
    this.write(message);
    return new Promise<T>((resolve, reject) => {
      this.pendingRpc.set(id, {
        resolve: value => resolve(value as T),
        reject,
      });
    });
  }

  private notify(message: ClientNotification): void {
    this.write(message);
  }

  private write(message: ClientRequest | ClientNotification | RpcResponse): void {
    if (this.stopped) return;
    chatDebug(`> ${JSON.stringify(message)}`);
    this.proc.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private async consumeStdout(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stdout) {
      this.stdoutBuffer += decoder.decode(chunk, { stream: true });
      this.drainStdout();
    }
    this.stdoutBuffer += decoder.decode();
    this.drainStdout(true);
  }

  private drainStdout(final = false): void {
    let newline: number;
    while ((newline = this.stdoutBuffer.indexOf("\n")) >= 0) {
      const line = this.stdoutBuffer.slice(0, newline);
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleLine(line);
    }
    if (final && this.stdoutBuffer.trim()) {
      this.handleLine(this.stdoutBuffer);
      this.stdoutBuffer = "";
    }
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    chatDebug(`< ${line}`);
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit({ type: "error", message: `Invalid Codex protocol message: ${line}` });
      return;
    }
    if (!message || typeof message !== "object") return;
    const record = message as Record<string, unknown>;
    if ("method" in record && "id" in record) {
      this.handleServerRequest(message as ServerRequest);
    } else if ("method" in record) {
      this.handleNotification(message as ServerNotification);
    } else if ("id" in record) {
      this.handleResponse(message as RpcResponse);
    }
  }

  private handleResponse(message: RpcResponse): void {
    const request = this.pendingRpc.get(message.id);
    if (!request) return;
    this.pendingRpc.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }

  private handleNotification(message: ServerNotification): void {
    if (message.method === "turn/started") {
      if (!this.completedTurns.has(message.params.turn.id)) {
        this.activeTurnId = message.params.turn.id;
        this.turnStartedAt = Date.now();
      }
      return;
    }
    if (message.method === "item/agentMessage/delta") {
      this.emit({ type: "delta", kind: "text", text: message.params.delta });
      return;
    }
    if (message.method === "item/reasoning/summaryTextDelta" || message.method === "item/reasoning/textDelta") {
      this.reasoningItemsWithDelta.add(message.params.itemId);
      this.emit({ type: "delta", kind: "thinking", text: message.params.delta });
      return;
    }
    if (message.method === "item/started") {
      this.handleItem(message.params.item, "start");
      return;
    }
    if (message.method === "item/completed") {
      this.handleItem(message.params.item, "end");
      return;
    }
    if (message.method === "thread/tokenUsage/updated") {
      this.latestUsage = message.params.tokenUsage;
      return;
    }
    if (message.method === "turn/completed") {
      this.completeTurn(message.params);
      return;
    }
    if (message.method === "error") {
      this.lastErrorMessage = message.params.error.message;
      this.emit({ type: "error", message: message.params.error.message });
      return;
    }
    if (message.method === "warning" || message.method === "guardianWarning") {
      const params = message.params as unknown as Record<string, unknown>;
      const text = typeof params.message === "string" ? params.message : JSON.stringify(params);
      this.emit({ type: "error", message: text });
      return;
    }
    if (message.method === "configWarning") {
      const { summary, details } = message.params;
      this.emit({ type: "error", message: details ? `${summary}\n${details}` : summary });
    }
  }

  private handleItem(item: ThreadItem, phase: "start" | "end"): void {
    if (item.type === "agentMessage") {
      if (phase === "end") this.emit({ type: "block", role: "assistant", content: item.text });
      return;
    }
    if (item.type === "reasoning") {
      if (phase === "end" && !this.reasoningItemsWithDelta.has(item.id)) {
        const text = [...item.summary, ...item.content].filter(Boolean).join("\n\n");
        if (text) this.emit({ type: "delta", kind: "thinking", text });
      }
      if (phase === "end") this.reasoningItemsWithDelta.delete(item.id);
      return;
    }
    const details = toolDetails(item);
    if (!details) return;
    this.toolNames.set(item.id, details.name);
    if (phase === "start") {
      this.emit({ type: "tool", phase, id: item.id, name: details.name, input: details.input });
    } else {
      this.emit({
        type: "tool",
        phase,
        id: item.id,
        name: this.toolNames.get(item.id) ?? details.name,
        result: details.result,
        isError: details.isError,
      });
      this.toolNames.delete(item.id);
    }
  }

  private completeTurn(params: TurnCompletedNotification): void {
    this.completedTurns.add(params.turn.id);
    if (this.completedTurns.size > 32) {
      for (const id of this.completedTurns) {
        if (this.completedTurns.size <= 16) break;
        this.completedTurns.delete(id);
      }
    }
    if (this.interruptFallback) {
      clearTimeout(this.interruptFallback);
      this.interruptFallback = null;
    }
    if (params.turn.status === "failed") {
      const message = params.turn.error?.message ?? "Codex turn failed";
      if (message !== this.lastErrorMessage) this.emit({ type: "error", message });
    }
    this.lastErrorMessage = null;
    const durationMs = params.turn.durationMs ?? Math.max(0, Date.now() - this.turnStartedAt);
    this.emit({ type: "result", costUsd: 0, usage: this.latestUsage, durationMs });
    if (this.activeTurnId === params.turn.id) this.activeTurnId = null;
    this.latestUsage = null;
    this.denyPendingApprovals();
    this.emit({ type: "status", status: "idle" });
    if (this.queue.length) {
      this.emit({ type: "status", status: "working" });
      void this.pump();
    }
  }

  private handleServerRequest(request: ServerRequest): void {
    if (request.method === "item/commandExecution/requestApproval") {
      const id = randomUUID();
      this.pendingApprovals.set(id, {
        respond: response => {
          const result: CommandExecutionRequestApprovalResponse = {
            decision: response.behavior === "allow"
              ? response.always ? "acceptForSession" : "accept"
              : "decline",
          };
          this.write({ id: request.id, result });
        },
      });
      this.emit({
        type: "permission_request",
        id,
        toolName: "Bash",
        input: {
          command: request.params.command,
          cwd: request.params.cwd,
          reason: request.params.reason,
          actions: request.params.commandActions,
        },
      });
      this.emit({ type: "status", status: "waiting" });
      return;
    }
    if (request.method === "item/fileChange/requestApproval") {
      const id = randomUUID();
      this.pendingApprovals.set(id, {
        respond: response => {
          const result: FileChangeRequestApprovalResponse = {
            decision: response.behavior === "allow"
              ? response.always ? "acceptForSession" : "accept"
              : "decline",
          };
          this.write({ id: request.id, result });
        },
      });
      this.emit({
        type: "permission_request",
        id,
        toolName: "ApplyPatch",
        input: {
          itemId: request.params.itemId,
          reason: request.params.reason,
          grantRoot: request.params.grantRoot,
        },
      });
      this.emit({ type: "status", status: "waiting" });
      return;
    }
    if (request.method === "item/permissions/requestApproval") {
      const id = randomUUID();
      this.pendingApprovals.set(id, {
        respond: response => {
          const requested = request.params.permissions;
          const result: PermissionsRequestApprovalResponse = {
            permissions: response.behavior === "allow"
              ? {
                  ...(requested.network ? { network: requested.network } : {}),
                  ...(requested.fileSystem ? { fileSystem: requested.fileSystem } : {}),
                }
              : {},
            scope: response.always ? "session" : "turn",
          };
          this.write({ id: request.id, result });
        },
      });
      this.emit({
        type: "permission_request",
        id,
        toolName: "Permissions",
        input: request.params as unknown as Record<string, unknown>,
      });
      this.emit({ type: "status", status: "waiting" });
      return;
    }
    if (request.method === "execCommandApproval" || request.method === "applyPatchApproval") {
      const id = randomUUID();
      this.pendingApprovals.set(id, {
        respond: response => {
          const decision = response.behavior === "allow"
            ? response.always ? "approved_for_session" : "approved"
            : { denied: { rejection: response.message ?? "" } };
          this.write({ id: request.id, result: { decision } });
        },
      });
      this.emit({
        type: "permission_request",
        id,
        toolName: request.method === "execCommandApproval" ? "Bash" : "ApplyPatch",
        input: request.params as unknown as Record<string, unknown>,
      });
      this.emit({ type: "status", status: "waiting" });
      return;
    }
    this.write({
      id: request.id,
      error: { code: -32601, message: `Unsupported Codex server request: ${request.method}` },
    });
  }

  private denyPendingApprovals(): void {
    for (const approval of this.pendingApprovals.values()) {
      approval.respond({ behavior: "deny" });
    }
    this.pendingApprovals.clear();
  }

  private async consumeStderr(): Promise<void> {
    const decoder = new TextDecoder();
    for await (const chunk of this.proc.stderr) {
      this.stderrText += decoder.decode(chunk, { stream: true });
      if (this.stderrText.length > 16_000) this.stderrText = this.stderrText.slice(-16_000);
    }
    this.stderrText += decoder.decode();
  }

  private async watchExit(): Promise<void> {
    const code = await this.proc.exited;
    if (this.stopped) return;
    this.stopped = true;
    this.dead = true;
    const detail = this.stderrText.trim();
    const error = new Error(detail || `codex app-server exited with code ${code}`);
    for (const request of this.pendingRpc.values()) request.reject(error);
    this.pendingRpc.clear();
    this.pendingApprovals.clear();
    this.emit({ type: "error", message: error.message });
    this.emit({ type: "status", status: "idle" });
  }
}

export const codexChatDriver: ChatDriver = {
  start: options => new CodexChatHandle(options),
};

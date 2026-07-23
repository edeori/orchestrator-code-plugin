import { randomUUID } from "crypto";
import type { Agent, AgentModel, AgentQuotaFailure, AgentRunOptions, AgentRunResult } from "./agent";
import type { AgentEvent, ElicitationResponse, PermissionDecision } from "./agentEvent";
import { CodexAppServerClient, type RpcId } from "./codexAppServer";
import { DelegateBridge } from "./delegateBridge";

type JsonObject = Record<string, unknown>;

interface PendingQuestion {
  rpcId: RpcId;
  questions: Array<{ id: string; options?: Array<{ label: string }> }>;
  timer?: NodeJS.Timeout;
}

interface PendingPermission {
  rpcId: RpcId;
  method: string;
  params: JsonObject;
}

interface PendingElicitation {
  rpcId: RpcId;
}

interface TurnCompletion {
  resolve: (result: AgentRunResult) => void;
}

/**
 * Rich Codex integration backed by the bidirectional App Server protocol.
 * One process and one thread are retained across `run()` calls, so follow-up
 * messages continue the native Codex conversation instead of starting an
 * unrelated `codex exec` process each time.
 */
export class CodexAgent implements Agent {
  readonly id = "codex" as const;

  private client: CodexAppServerClient | undefined;
  private clientReady: Promise<void> | undefined;
  private threadId: string | undefined;
  private threadCwd: string | undefined;
  private activeTurnId: string | undefined;
  private active = false;
  private disposed = false;
  private needsResume: boolean;
  private eventSink: ((event: AgentEvent) => void) | undefined;
  private turnCompletion: TurnCompletion | undefined;
  private activeQuotaFailure: AgentQuotaFailure | undefined;
  private readonly pendingQuestions = new Map<string, PendingQuestion>();
  private readonly pendingPermissions = new Map<string, PendingPermission>();
  private readonly pendingElicitations = new Map<string, PendingElicitation>();
  private modelCatalog: AgentModel[] | undefined;
  private modelCatalogReady: Promise<AgentModel[]> | undefined;
  /**
   * Set once the user picks "allow-repo" for this workspace (or the
   * extension restored that choice from a previous session). Relaxes the
   * approval policy passed to `thread/start`/`thread/resume` from then on —
   * see `ensureThread`.
   */
  private repoTrusted: boolean;
  /** Guards `registerDelegateBridge` so it only runs once per app-server process. */
  private delegateBridgeRegistered = false;

  constructor(
    private readonly command: string,
    initialThreadId?: string,
    private readonly onThreadIdChanged?: (threadId: string | undefined) => void | Promise<void>,
    initialRepoTrusted = false,
    private readonly onRepoTrustChanged?: (trusted: boolean) => void | Promise<void>,
    /** Lets this Codex thread hand a subtask to Claude — see delegateBridge.ts. Omitted (e.g. no workspace) disables the "delegate_to_claude" tool entirely rather than registering a broken one. */
    private readonly delegateBridge?: DelegateBridge,
    private readonly delegateBridgeNodeCommand = "node"
  ) {
    this.threadId = initialThreadId;
    this.needsResume = Boolean(initialThreadId);
    this.repoTrusted = initialRepoTrusted;
  }

  answerQuestion(id: string, answers: Record<string, string[]>): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending || !this.client) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pendingQuestions.delete(id);

    const normalized = Object.fromEntries(
      pending.questions.map((question) => [question.id, { answers: answers[question.id] ?? [] }])
    );
    try {
      this.client.respond(pending.rpcId, { answers: normalized });
      this.emit({ type: "interactionResolved", id, resolution: "answered" });
    } catch (error) {
      this.emit({ type: "error", message: (error as Error).message });
    }
  }

  resolvePermission(id: string, decision: PermissionDecision): void {
    const pending = this.pendingPermissions.get(id);
    if (!pending || !this.client) return;
    this.pendingPermissions.delete(id);
    // "allow-repo" resolves *this* request exactly like "allow-session" (Codex's
    // app-server has no live "trust this project forever" scope of its own) and
    // additionally persists trust so future threads for this cwd start with a
    // relaxed approval policy instead of prompting again — see trustCurrentRepo.
    const sessionLike = decision === "allow-session" || decision === "allow-repo";

    try {
      if (pending.method === "item/commandExecution/requestApproval") {
        const available = Array.isArray(pending.params.availableDecisions)
          ? pending.params.availableDecisions
          : [];
        const supportsSession = available.some((value) => value === "acceptForSession");
        const nativeDecision =
          decision === "deny" ? "decline" : sessionLike && supportsSession ? "acceptForSession" : "accept";
        this.client.respond(pending.rpcId, { decision: nativeDecision });
      } else if (pending.method === "item/fileChange/requestApproval") {
        this.client.respond(pending.rpcId, {
          decision: decision === "deny" ? "decline" : sessionLike ? "acceptForSession" : "accept",
        });
      } else {
        const requested = asObject(pending.params.permissions);
        const permissions: JsonObject = {};
        if (decision !== "deny") {
          if (requested.network !== null && requested.network !== undefined) permissions.network = requested.network;
          if (requested.fileSystem !== null && requested.fileSystem !== undefined) permissions.fileSystem = requested.fileSystem;
        }
        this.client.respond(pending.rpcId, {
          permissions,
          scope: sessionLike ? "session" : "turn",
        });
      }
      this.emit({ type: "interactionResolved", id, resolution: decision === "deny" ? "denied" : "answered" });
      if (decision === "allow-repo") void this.trustCurrentRepo();
    } catch (error) {
      this.emit({ type: "error", message: (error as Error).message });
    }
  }

  resolveElicitation(id: string, response: ElicitationResponse): void {
    const pending = this.pendingElicitations.get(id);
    if (!pending || !this.client) return;
    this.pendingElicitations.delete(id);
    try {
      this.client.respond(pending.rpcId, {
        action: response.action,
        content: response.action === "accept" ? (response.content ?? null) : null,
        _meta: null,
      });
      this.emit({
        type: "interactionResolved",
        id,
        resolution: response.action === "accept" ? "answered" : response.action === "decline" ? "denied" : "cancelled",
      });
    } catch (error) {
      this.emit({ type: "error", message: (error as Error).message });
    }
  }

  async initialize(cwd: string): Promise<void> {
    if (this.disposed) throw new Error("The Codex session has already been disposed.");
    await this.ensureClient(cwd);
    await this.registerDelegateBridge();
    await this.availableModels(cwd);
    await this.ensureThread(cwd);
  }

  /**
   * Registers (once per app-server process) `delegate_to_claude` as an
   * external MCP server so Codex can hand a subtask to Claude — e.g. for
   * machine-control actions Claude has (screenshots, opening apps). This is
   * best-effort: if it fails, Codex just runs without that tool rather than
   * failing the whole session. See delegateBridge.ts for why this can't be
   * an in-process tool the way Claude's own `delegate_to_codex` is.
   */
  private async registerDelegateBridge(): Promise<void> {
    if (this.delegateBridgeRegistered || !this.delegateBridge || !this.client) return;
    this.delegateBridgeRegistered = true;
    try {
      const socketPath = await this.delegateBridge.ensureListening();
      await this.client.request("config/value/write", {
        keyPath: "mcp_servers.orchestrator_delegate",
        mergeStrategy: "replace",
        value: {
          command: this.delegateBridgeNodeCommand,
          args: [DelegateBridge.scriptPath],
          env: { ORCHESTRATOR_DELEGATE_SOCKET: socketPath },
        },
      });
      await this.client.request("config/mcpServer/reload", null);
    } catch (error) {
      this.emit({
        type: "error",
        message: `Could not register the Claude delegate tool for Codex: ${(error as Error).message}`,
      });
    }
  }

  availableModels(cwd: string): Promise<AgentModel[]> {
    if (this.modelCatalog) return Promise.resolve(this.modelCatalog);
    if (this.modelCatalogReady) return this.modelCatalogReady;
    this.modelCatalogReady = this.discoverModels(cwd)
      .catch(() => [defaultCodexModel()])
      .then((models) => {
        this.modelCatalog = models.length ? models : [defaultCodexModel()];
        return this.modelCatalog;
      })
      .finally(() => {
        this.modelCatalogReady = undefined;
      });
    return this.modelCatalogReady;
  }

  async run({ prompt, cwd, model, effort, onEvent }: AgentRunOptions): Promise<AgentRunResult> {
    if (this.disposed) throw new Error("The Codex session has already been disposed.");
    if (this.active) throw new Error("Codex is already handling another turn.");

    this.active = true;
    this.eventSink = onEvent;
    this.activeQuotaFailure = undefined;
    let result: AgentRunResult = { exitCode: 1 };
    try {
      await this.initialize(cwd);
      const knownQuotaFailure = await this.refreshRateLimits();
      if (knownQuotaFailure) {
        this.emit({ type: "error", message: knownQuotaFailure.message });
        return { exitCode: 1, failure: knownQuotaFailure };
      }

      const completion = new Promise<AgentRunResult>((resolve) => {
        this.turnCompletion = { resolve };
      });
      const response = await this.client!.request<JsonObject>("turn/start", {
        threadId: this.threadId,
        input: [{ type: "text", text: prompt, text_elements: [] }],
        ...(model && model !== "default" ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      this.activeTurnId = asObject(response.turn).id as string | undefined;
      result = await completion;
    } catch (error) {
      const message = (error as Error).message;
      this.emit({ type: "error", message });
      const failure = isCodexQuotaMessage(message)
        ? { kind: "quota" as const, message }
        : this.activeQuotaFailure;
      result = { exitCode: 1, failure };
    } finally {
      this.active = false;
      this.activeTurnId = undefined;
      this.turnCompletion = undefined;
      this.activeQuotaFailure = undefined;
      this.emit({ type: "done", exitCode: result.exitCode });
    }
    return result;
  }

  async interrupt(): Promise<void> {
    if (!this.client || !this.threadId || !this.activeTurnId) return;
    try {
      await this.client.request("turn/interrupt", {
        threadId: this.threadId,
        turnId: this.activeTurnId,
      });
    } catch (error) {
      this.emit({ type: "error", message: `Could not interrupt Codex: ${(error as Error).message}` });
    }
  }

  async steer(text: string): Promise<boolean> {
    if (!this.client || !this.threadId || !this.activeTurnId || !text.trim()) return false;
    await this.client.request("turn/steer", {
      threadId: this.threadId,
      expectedTurnId: this.activeTurnId,
      input: [{ type: "text", text: text.trim(), text_elements: [] }],
    });
    return true;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, pending] of this.pendingQuestions) {
      if (pending.timer) clearTimeout(pending.timer);
      this.emit({ type: "interactionResolved", id, resolution: "cancelled" });
    }
    this.pendingQuestions.clear();
    for (const id of this.pendingPermissions.keys()) {
      this.emit({ type: "interactionResolved", id, resolution: "cancelled" });
    }
    this.pendingPermissions.clear();
    for (const [id, pending] of this.pendingElicitations) {
      try {
        this.client?.respond(pending.rpcId, { action: "cancel", content: null, _meta: null });
      } catch {
        // The transport is being torn down anyway.
      }
      this.emit({ type: "interactionResolved", id, resolution: "cancelled" });
    }
    this.pendingElicitations.clear();
    this.client?.dispose();
    this.client = undefined;
    this.turnCompletion?.resolve({ exitCode: 1 });
  }

  private async ensureClient(cwd: string): Promise<void> {
    if (this.clientReady) return this.clientReady;

    this.client = new CodexAppServerClient(this.command, {
      onNotification: (method, params) => this.handleNotification(method, params),
      onRequest: (id, method, params) => this.handleServerRequest(id, method, params),
      onProtocolError: (error) => this.emit({ type: "error", message: error.message }),
      onExit: (error) => {
        this.emit({ type: "error", message: error.message });
        this.turnCompletion?.resolve({ exitCode: 1, failure: this.activeQuotaFailure });
        this.client = undefined;
        this.clientReady = undefined;
        this.modelCatalog = undefined;
        this.modelCatalogReady = undefined;
        // The persisted thread remains valid even if this transport crashes.
        // A replacement app-server process can rejoin it on the next turn.
        this.needsResume = Boolean(this.threadId);
        this.threadCwd = undefined;
      },
    });
    this.clientReady = this.client.start(cwd).catch((error) => {
      this.client?.dispose();
      this.client = undefined;
      this.clientReady = undefined;
      throw error;
    });
    return this.clientReady;
  }

  private async ensureThread(cwd: string): Promise<void> {
    if (this.threadId && this.threadCwd === cwd && !this.needsResume) return;

    if (this.threadId) {
      try {
        const response = await this.client!.request<JsonObject>("thread/resume", {
          threadId: this.threadId,
          cwd,
          approvalPolicy: this.approvalPolicyFor(),
          sandbox: "workspace-write",
          excludeTurns: true,
        });
        const thread = asObject(response.thread);
        if (typeof thread.id !== "string") throw new Error("Codex app-server did not return a resumed thread id.");
        this.threadId = thread.id;
        this.threadCwd = cwd;
        this.needsResume = false;
        await this.onThreadIdChanged?.(thread.id);
        return;
      } catch (error) {
        if (!isMissingCodexThreadError(error)) throw error;
        // A deleted, incompatible or otherwise stale rollout should not make
        // the chat unusable. Clear it before the new prompt is submitted.
        this.threadId = undefined;
        this.threadCwd = undefined;
        this.needsResume = false;
        await this.onThreadIdChanged?.(undefined);
      }
    }

    const response = await this.client!.request<JsonObject>("thread/start", {
      cwd,
      approvalPolicy: this.approvalPolicyFor(),
      sandbox: "workspace-write",
      ephemeral: false,
    });
    const thread = asObject(response.thread);
    if (typeof thread.id !== "string") throw new Error("Codex app-server did not return a thread id.");
    this.threadId = thread.id;
    this.threadCwd = cwd;
    this.needsResume = false;
    await this.onThreadIdChanged?.(thread.id);
  }

  /**
   * "on-request" (today's always-ask default) unless the user already
   * picked "allow-repo" for this workspace, in which case Codex is told to
   * only ask when a sandboxed command actually fails/needs escalation —
   * matching how a plain `codex` CLI session treats a folder it already
   * trusts, rather than re-prompting on every single command again.
   */
  private approvalPolicyFor(): "on-request" | "on-failure" {
    return this.repoTrusted ? "on-failure" : "on-request";
  }

  /**
   * Persists "this project is trusted" two ways: in the extension's own
   * workspace state (via `onRepoTrustChanged`, which is what actually gates
   * `approvalPolicyFor` above on the next thread start/resume — including
   * after restarting VS Code) and, best-effort, into Codex's own
   * `~/.codex/config.toml` project-trust table via `config/value/write`, so
   * a plain `codex` CLI session on the same folder benefits too. The
   * config.toml write is a bonus, not required for this plugin's own
   * behavior, so its failure is swallowed.
   */
  private async trustCurrentRepo(): Promise<void> {
    if (!this.repoTrusted) {
      this.repoTrusted = true;
      await this.onRepoTrustChanged?.(true);
    }
    const cwd = this.threadCwd;
    if (!cwd || !this.client) return;
    try {
      await this.client.request("config/value/write", {
        keyPath: `projects.${JSON.stringify(cwd)}.trust_level`,
        mergeStrategy: "replace",
        value: "trusted",
      });
    } catch {
      // Best-effort only — see doc comment above.
    }
  }

  private async refreshRateLimits(): Promise<AgentQuotaFailure | undefined> {
    try {
      const response = await this.client!.request<JsonObject>("account/rateLimits/read", undefined);
      return this.emitRateLimitsFromResponse(response);
    } catch {
      // API-key and some third-party-provider sessions have no account window.
      // A missing account gauge must not prevent the coding turn from running.
      return undefined;
    }
  }

  private async discoverModels(cwd: string): Promise<AgentModel[]> {
    await this.ensureClient(cwd);
    const response = await this.client!.request<JsonObject>("model/list", {
      limit: 100,
      includeHidden: false,
    });
    const data = Array.isArray(response.data) ? response.data : [];
    return data.flatMap((raw, index): AgentModel[] => {
      const model = asObject(raw);
      const id = typeof model.id === "string" ? model.id : typeof model.model === "string" ? model.model : undefined;
      if (!id) return [];
      const supported = Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
            .map((entry) => asObject(entry).reasoningEffort)
            .filter((value): value is string => typeof value === "string")
        : [];
      return [{
        agent: "codex",
        id,
        displayName: typeof model.displayName === "string" ? model.displayName : id,
        description: typeof model.description === "string" ? model.description : "Codex model",
        isDefault: model.isDefault === true || index === 0,
        supportedEfforts: supported,
        defaultEffort: typeof model.defaultReasoningEffort === "string" ? model.defaultReasoningEffort : undefined,
      }];
    });
  }

  private handleNotification(method: string, rawParams: unknown): void {
    const params = asObject(rawParams);

    if (method === "item/agentMessage/delta" && this.belongsToCurrentThread(params)) {
      if (typeof params.delta === "string") this.emit({ type: "text", text: params.delta });
      return;
    }

    if (method === "thread/tokenUsage/updated" && this.belongsToCurrentThread(params)) {
      const usage = asObject(params.tokenUsage);
      const total = asObject(usage.total);
      const usedTokens = numberOrZero(total.totalTokens);
      const maxTokens = numberOrZero(usage.modelContextWindow);
      if (maxTokens > 0) {
        this.emit({
          type: "usage",
          context: {
            usedTokens,
            maxTokens,
            percentage: Math.min(100, (usedTokens / maxTokens) * 100),
          },
        });
      }
      return;
    }

    if (method === "account/rateLimits/updated") {
      const snapshot = asObject(params.rateLimits);
      this.emitRateLimitSnapshots([snapshot]);
      this.activeQuotaFailure ??= quotaFailureFromRateLimitSnapshots([snapshot]);
      return;
    }

    if (method === "serverRequest/resolved") {
      const requestId = params.requestId;
      for (const [id, pending] of this.pendingQuestions) {
        if (pending.rpcId !== requestId) continue;
        if (pending.timer) clearTimeout(pending.timer);
        this.pendingQuestions.delete(id);
        this.emit({ type: "interactionResolved", id, resolution: "timed-out" });
      }
      for (const [id, pending] of this.pendingPermissions) {
        if (pending.rpcId !== requestId) continue;
        this.pendingPermissions.delete(id);
        this.emit({ type: "interactionResolved", id, resolution: "cancelled" });
      }
      for (const [id, pending] of this.pendingElicitations) {
        if (pending.rpcId !== requestId) continue;
        this.pendingElicitations.delete(id);
        this.emit({ type: "interactionResolved", id, resolution: "cancelled" });
      }
      return;
    }

    if ((method === "item/started" || method === "item/completed") && this.belongsToCurrentThread(params)) {
      const item = asObject(params.item);
      const activity = activityFromItem(item, method === "item/started" ? "started" : "completed");
      if (activity) this.emit(activity);
      return;
    }

    if (method === "error" && this.belongsToCurrentThread(params)) {
      const error = asObject(params.error);
      if (typeof error.message === "string") {
        this.emit({ type: "error", message: error.message });
        if (params.willRetry !== true && isCodexUsageLimitError(error)) {
          this.activeQuotaFailure = { kind: "quota", message: error.message };
        }
      }
      return;
    }

    if (method === "turn/completed" && this.belongsToCurrentThread(params)) {
      const turn = asObject(params.turn);
      const turnId = typeof turn.id === "string" ? turn.id : undefined;
      if (this.activeTurnId && turnId && turnId !== this.activeTurnId) return;
      if (!this.activeTurnId) this.activeTurnId = turnId;
      const error = asObject(turn.error);
      if (typeof error.message === "string") this.emit({ type: "error", message: error.message });
      if (isCodexUsageLimitError(error)) {
        this.activeQuotaFailure = { kind: "quota", message: String(error.message ?? "Codex usage limit reached.") };
      }
      this.turnCompletion?.resolve({
        exitCode: turn.status === "completed" ? 0 : 1,
        failure: turn.status === "completed" ? undefined : this.activeQuotaFailure,
      });
    }
  }

  private handleServerRequest(rpcId: RpcId, method: string, rawParams: unknown): void {
    const params = asObject(rawParams);
    if (method === "mcpServer/elicitation/request") {
      const mode = params.mode === "url" ? "url" : "form";
      const id = randomUUID();
      this.pendingElicitations.set(id, { rpcId });
      this.emit({
        type: "elicitation",
        id,
        serverName: typeof params.serverName === "string" ? params.serverName : "MCP server",
        mode,
        message: typeof params.message === "string" ? params.message : "This MCP server needs more information.",
        title: typeof params.title === "string" ? params.title : undefined,
        schema: mode === "form" ? asObject(params.requestedSchema) : undefined,
        url: mode === "url" && typeof params.url === "string" ? params.url : undefined,
      });
      return;
    }

    if (method === "item/tool/requestUserInput") {
      const rawQuestions = Array.isArray(params.questions) ? params.questions : [];
      const questions = rawQuestions.map((raw, index) => {
        const question = asObject(raw);
        const options = Array.isArray(question.options)
          ? question.options.map((option) => {
              const value = asObject(option);
              return {
                label: String(value.label ?? ""),
                description: String(value.description ?? ""),
              };
            })
          : undefined;
        return {
          id: typeof question.id === "string" ? question.id : String(index),
          header: typeof question.header === "string" ? question.header : "Question",
          question: typeof question.question === "string" ? question.question : "",
          multiSelect: false,
          options,
          allowFreeText: !options,
          isOther: question.isOther === true,
          isSecret: question.isSecret === true,
        };
      });
      const id = randomUUID();
      const autoResolutionMs = typeof params.autoResolutionMs === "number" ? params.autoResolutionMs : null;
      const pending: PendingQuestion = {
        rpcId,
        questions: questions.map((question) => ({ id: question.id, options: question.options })),
      };
      if (autoResolutionMs !== null) {
        pending.timer = setTimeout(() => this.autoResolveQuestion(id), Math.max(0, autoResolutionMs));
      }
      this.pendingQuestions.set(id, pending);
      this.emit({ type: "question", id, questions, autoResolutionMs });
      return;
    }

    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval" ||
      method === "item/permissions/requestApproval"
    ) {
      const id = randomUUID();
      const permission = permissionFromRequest(id, method, params);
      this.pendingPermissions.set(id, { rpcId, method, params });
      this.emit(permission);
      return;
    }

    this.client?.respondError(rpcId, -32601, `Unsupported Codex server request: ${method}`);
    this.emit({ type: "error", message: `Unsupported Codex interaction: ${method}` });
  }

  private autoResolveQuestion(id: string): void {
    const pending = this.pendingQuestions.get(id);
    if (!pending || !this.client) return;
    this.pendingQuestions.delete(id);
    const answers = Object.fromEntries(
      pending.questions.map((question) => [question.id, { answers: question.options?.[0] ? [question.options[0].label] : [] }])
    );
    try {
      this.client.respond(pending.rpcId, { answers });
      this.emit({ type: "interactionResolved", id, resolution: "timed-out" });
    } catch (error) {
      this.emit({ type: "error", message: (error as Error).message });
    }
  }

  private emitRateLimitsFromResponse(response: JsonObject): AgentQuotaFailure | undefined {
    const byId = asObject(response.rateLimitsByLimitId);
    const snapshots = Object.values(byId).map(asObject);
    if (snapshots.length === 0 && response.rateLimits) snapshots.push(asObject(response.rateLimits));
    this.emitRateLimitSnapshots(snapshots);
    return quotaFailureFromRateLimitSnapshots(snapshots);
  }

  private emitRateLimitSnapshots(snapshots: JsonObject[]): void {
    const rateLimits: NonNullable<Extract<AgentEvent, { type: "usage" }>["rateLimits"]> = [];
    for (const snapshot of snapshots) {
      const baseId = String(snapshot.limitId ?? "codex");
      const baseLabel = String(snapshot.limitName ?? snapshot.limitId ?? "Codex");
      for (const [name, rawWindow] of [
        ["primary", snapshot.primary],
        ["secondary", snapshot.secondary],
      ] as const) {
        if (!rawWindow) continue;
        const window = asObject(rawWindow);
        if (typeof window.usedPercent !== "number") continue;
        const duration = typeof window.windowDurationMins === "number" ? window.windowDurationMins : null;
        rateLimits.push({
          id: `${baseId}:${name}`,
          label: `${baseLabel}${duration ? ` · ${formatDuration(duration)}` : ""}`,
          usedPercent: Math.max(0, Math.min(100, window.usedPercent)),
          windowDurationMinutes: duration,
          resetsAt: typeof window.resetsAt === "number" ? window.resetsAt : null,
        });
      }
    }
    if (rateLimits.length) this.emit({ type: "usage", rateLimits });
  }

  private belongsToCurrentThread(params: JsonObject): boolean {
    return !this.threadId || typeof params.threadId !== "string" || params.threadId === this.threadId;
  }

  private emit(event: AgentEvent): void {
    this.eventSink?.(event);
  }
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as JsonObject) : {};
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isMissingCodexThreadError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /no rollout found|thread[^\n]*not found|not found[^\n]*thread/i.test(message);
}

function isCodexUsageLimitError(error: JsonObject): boolean {
  return error.codexErrorInfo === "usageLimitExceeded" ||
    (typeof error.message === "string" && isCodexQuotaMessage(error.message));
}

function isCodexQuotaMessage(message: string): boolean {
  return /\b(?:usage limit (?:is )?(?:reached|exceeded)|quota (?:is )?(?:reached|exceeded)|credits? (?:are )?(?:depleted|exhausted)|out of (?:usage )?credits?)\b/i.test(message);
}

function quotaFailureFromRateLimitSnapshots(snapshots: JsonObject[]): AgentQuotaFailure | undefined {
  const exhausted = snapshots.find((snapshot) =>
    typeof snapshot.rateLimitReachedType === "string" || snapshot.spendControlReached === true
  );
  if (!exhausted) return undefined;

  const retryAt = [exhausted.primary, exhausted.secondary]
    .map(asObject)
    .map((window) => normalizeProviderTimestamp(window.resetsAt))
    .filter((value): value is number => value !== undefined && value > Date.now())
    .sort((left, right) => left - right)[0];
  const reachedType = typeof exhausted.rateLimitReachedType === "string"
    ? exhausted.rateLimitReachedType.replace(/_/g, " ")
    : "spend control reached";
  return {
    kind: "quota",
    message: `Codex is unavailable because its ${reachedType}.`,
    retryAt,
  };
}

function normalizeProviderTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function defaultCodexModel(): AgentModel {
  return {
    agent: "codex",
    id: "default",
    displayName: "Codex default",
    description: "The default model selected by the authenticated Codex account.",
    isDefault: true,
    supportedEfforts: [],
  };
}

function formatDuration(minutes: number): string {
  if (minutes % (7 * 24 * 60) === 0) return `${minutes / (7 * 24 * 60)}w`;
  if (minutes % (24 * 60) === 0) return `${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

function permissionFromRequest(
  id: string,
  method: string,
  params: JsonObject
): Extract<AgentEvent, { type: "permission" }> {
  if (method === "item/commandExecution/requestApproval") {
    const command = typeof params.command === "string" ? params.command : "Unknown command";
    const cwd = typeof params.cwd === "string" ? `\nWorking directory: ${params.cwd}` : "";
    const reason = typeof params.reason === "string" ? `\nReason: ${params.reason}` : "";
    const native = Array.isArray(params.availableDecisions) ? params.availableDecisions : [];
    const availableDecisions: PermissionDecision[] = ["allow-once", "deny"];
    // "allow-repo" doesn't need native 'acceptForSession' support: it
    // resolves this one request the same way 'allow-once' would (falling
    // back to a plain 'accept' if the session scope isn't offered) and
    // separately persists trust for the project — see resolvePermission.
    if (native.length === 0 || native.includes("acceptForSession")) availableDecisions.splice(1, 0, "allow-session");
    availableDecisions.splice(-1, 0, "allow-repo");
    return {
      type: "permission",
      id,
      kind: "command",
      title: "Codex wants to run a command",
      description: `${command}${cwd}${reason}`,
      availableDecisions,
    };
  }
  if (method === "item/fileChange/requestApproval") {
    const reason = typeof params.reason === "string" ? params.reason : "Codex wants to modify files.";
    const root = typeof params.grantRoot === "string" ? `\nRequested root: ${params.grantRoot}` : "";
    return {
      type: "permission",
      id,
      kind: "fileChange",
      title: "Codex wants to modify files",
      description: `${reason}${root}`,
      availableDecisions: ["allow-once", "allow-session", "allow-repo", "deny"],
    };
  }

  const requested = asObject(params.permissions);
  const hasNetwork = requested.network !== null && requested.network !== undefined;
  const hasFilesystem = requested.fileSystem !== null && requested.fileSystem !== undefined;
  return {
    type: "permission",
    id,
    kind: hasNetwork && !hasFilesystem ? "network" : "filesystem",
    title: hasNetwork ? "Codex requests additional access" : "Codex requests filesystem access",
    description: `${typeof params.reason === "string" ? `${params.reason}\n` : ""}${JSON.stringify(requested, null, 2)}`,
    availableDecisions: ["allow-once", "allow-session", "allow-repo", "deny"],
  };
}

function activityFromItem(
  item: JsonObject,
  status: "started" | "completed"
): Extract<AgentEvent, { type: "activity" }> | undefined {
  const id = typeof item.id === "string" ? item.id : randomUUID();
  switch (item.type) {
    case "commandExecution":
      return {
        type: "activity",
        id,
        kind: "command",
        status: item.status === "failed" ? "failed" : status,
        label: typeof item.command === "string" ? item.command : "Command",
      };
    case "fileChange": {
      const count = Array.isArray(item.changes) ? item.changes.length : 0;
      return {
        type: "activity",
        id,
        kind: "fileChange",
        status: item.status === "failed" ? "failed" : status,
        label: count ? `${count} file change${count === 1 ? "" : "s"}` : "File changes",
      };
    }
    case "mcpToolCall":
      return {
        type: "activity",
        id,
        kind: "mcp",
        status: item.status === "failed" ? "failed" : status,
        label: `${String(item.server ?? "MCP")}.${String(item.tool ?? "tool")}`,
      };
    case "dynamicToolCall":
      return {
        type: "activity",
        id,
        kind: "other",
        status: item.success === false ? "failed" : status,
        label: String(item.tool ?? "Tool"),
      };
    case "webSearch":
      return { type: "activity", id, kind: "webSearch", status, label: "Web search" };
    case "collabAgentToolCall":
      return { type: "activity", id, kind: "other", status, label: `Agent: ${String(item.tool ?? "collaboration")}` };
    default:
      return undefined;
  }
}

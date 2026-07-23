import { randomUUID } from "crypto";
import * as vscode from "vscode";
import { GroqQuotaError, GroqRouter, GroqRoutingError, OllamaCloudRouter, OllamaRouter } from "../orchestrator/router";
import type { RoutingDecision } from "../orchestrator/router";
import { alternateAgent, describeModelClass, selectEquivalentModel } from "../orchestrator/fallback";
import { OrchestrationSession, ProjectSessionManager } from "../orchestrator/session";
import { ClaudeAgent } from "../agents/claudeAgent";
import { CodexAgent } from "../agents/codexAgent";
import { DelegateBridge, type DelegateResult } from "../agents/delegateBridge";
import type { Agent, AgentId, AgentModel, AgentRunResult } from "../agents/agent";
import type { AgentEvent, PermissionDecision } from "../agents/agentEvent";

type WebviewInMessage =
  | { type: "userMessage"; text: string }
  | { type: "answerQuestion"; id: string; answers: Record<string, string[]> }
  | { type: "resolvePermission"; id: string; decision: PermissionDecision }
  | {
      type: "resolveElicitation";
      id: string;
      action: "accept" | "decline" | "cancel";
      content?: Record<string, string | number | boolean | string[]>;
    }
  | { type: "openExternal"; url: string }
  | { type: "scanProject" }
  | { type: "queueMessage"; text: string }
  | { type: "steerMessage"; text: string }
  | { type: "newSession" }
  | { type: "switchSession"; id: string }
  | { type: "stop" };

type WebviewOutMessage =
  | ({ agent?: AgentId } & AgentEvent)
  | { type: "routing"; agent: string; model: string; reason: string }
  | { type: "scan"; text: string }
  | { type: "sessionStatus"; status: "loading" | "ready" | "error"; message: string }
  | { type: "queueState"; count: number }
  | { type: "composerNotice"; message: string; status: "queued" | "steered" | "started" }
  | {
      type: "sessionList";
      activeSessionId: string;
      sessions: Array<{
        id: string;
        title: string;
        updatedAt: number;
        claudeSessionId?: string;
        codexThreadId?: string;
      }>;
    }
  | { type: "runState"; running: boolean; agent?: AgentId };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "orchestratorCode.chatView";

  private webview: vscode.Webview | undefined;
  /** Native sessions are retained per provider so follow-up turns resume. */
  private readonly agents = new Map<AgentId, Agent>();
  /** Request-id routing stays stable even if the selected provider changes later. */
  private readonly pendingRequestAgents = new Map<string, Agent>();
  private activeAgent: Agent | undefined;
  private running = false;
  private activeTurnInterrupted = false;
  private sessionsReady: Promise<void> | undefined;
  private orchestrationSession: OrchestrationSession | undefined;
  private projectSessions: ProjectSessionManager | undefined;
  private readonly queuedMessages: string[] = [];
  /** Lets a running Codex turn hand a subtask to Claude — see delegateBridge.ts. */
  private readonly delegateBridge = new DelegateBridge((task) => this.delegateTask("codex", "claude", task));

  private static readonly providerQuotaKey = "orchestratorCode.quota.providers";
  private static readonly groqQuotaKey = "orchestratorCode.quota.groq";
  private static readonly unknownQuotaCooldownMs = 15 * 60 * 1_000;
  /**
   * Workspace folder paths the user picked "allow-repo" for on a Codex
   * permission prompt. Keyed by folder rather than a single flag since
   * `workspaceState` itself is already scoped to one VS Code window, but a
   * project can still be reopened under a different root path (e.g. moved,
   * or opened via a symlink) — storing the path keeps the trust decision
   * honest about which folder it actually applies to instead of silently
   * carrying over to an unrelated one.
   */
  private static readonly codexTrustedRepoKey = "orchestratorCode.codex.trustedRepos";

  static readonly groqApiKeySecret = "orchestratorCode.groqApiKey";
  static readonly ollamaCloudApiKeySecret = "orchestratorCode.ollamaCloudApiKey";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly workspaceState: vscode.Memento,
    private readonly secrets: vscode.SecretStorage
  ) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    this.webview = webviewView.webview;
    webviewView.webview.postMessage({ type: "sessionStatus", status: "loading", message: "Loading project sessions…" } satisfies WebviewOutMessage);
    void this.initializeSessions()
      .then(() => {
        this.publishSessionList();
        this.publishQueueState();
        webviewView.webview.postMessage({ type: "sessionStatus", status: "ready", message: "Project orchestrator, Claude and Codex sessions are ready." } satisfies WebviewOutMessage);
      })
      .catch((error) => webviewView.webview.postMessage({ type: "sessionStatus", status: "error", message: (error as Error).message } satisfies WebviewOutMessage));

    webviewView.webview.onDidReceiveMessage(async (message: WebviewInMessage) => {
      if (message.type === "userMessage") {
        await this.handleUserMessage(message.text, webviewView.webview);
      } else if (message.type === "answerQuestion") {
        const agent = this.pendingRequestAgents.get(message.id);
        this.pendingRequestAgents.delete(message.id);
        agent?.answerQuestion(message.id, message.answers);
      } else if (message.type === "resolvePermission") {
        const agent = this.pendingRequestAgents.get(message.id);
        this.pendingRequestAgents.delete(message.id);
        agent?.resolvePermission(message.id, message.decision);
      } else if (message.type === "resolveElicitation") {
        const agent = this.pendingRequestAgents.get(message.id);
        this.pendingRequestAgents.delete(message.id);
        agent?.resolveElicitation(message.id, { action: message.action, content: message.content });
      } else if (message.type === "openExternal") {
        const uri = safeExternalUri(message.url);
        if (uri) await vscode.env.openExternal(uri);
      } else if (message.type === "scanProject") {
        await vscode.commands.executeCommand("orchestratorCode.scanProject");
      } else if (message.type === "queueMessage") {
        this.enqueueMessage(message.text, webviewView.webview);
      } else if (message.type === "steerMessage") {
        await this.steerActiveTurn(message.text, webviewView.webview);
      } else if (message.type === "newSession") {
        await this.createProjectSession(webviewView.webview);
      } else if (message.type === "switchSession") {
        await this.switchProjectSession(message.id, webviewView.webview);
      } else if (message.type === "stop") {
        this.activeTurnInterrupted = true;
        await this.activeAgent?.interrupt();
      }
    });

    webviewView.onDidDispose(() => {
      this.dispose();
      this.webview = undefined;
    });
  }

  dispose(): void {
    void Promise.all([...this.agents.values()].map((agent) => agent.dispose()));
    this.agents.clear();
    this.pendingRequestAgents.clear();
    this.activeAgent = undefined;
    this.running = false;
    this.sessionsReady = undefined;
    this.queuedMessages.length = 0;
    this.delegateBridge.dispose();
  }

  initializeSessions(): Promise<void> {
    if (this.sessionsReady) return this.sessionsReady;
    this.sessionsReady = this.initializeSessionsInternal().catch((error) => {
      this.sessionsReady = undefined;
      throw error;
    });
    return this.sessionsReady;
  }

  private async initializeSessionsInternal(): Promise<void> {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) throw new Error("Open a workspace folder to start an orchestrated project session.");
    const config = vscode.workspace.getConfiguration("orchestratorCode");
    this.projectSessions ??= new ProjectSessionManager(this.workspaceState, workspaceRoot);
    await this.projectSessions.initialize();
    const current = this.projectSessions.current();
    this.orchestrationSession ??= this.projectSessions.orchestrationSession();

    if (!this.agents.has("claude")) {
      this.agents.set(
        "claude",
        new ClaudeAgent(
          current.claudeSessionId,
          async (sessionId) => {
            await this.projectSessions?.updateNativeSession(current.id, "claude", sessionId);
            this.publishSessionList();
          },
          (task) => this.delegateTask("claude", "codex", task)
        )
      );
    }
    if (!this.agents.has("codex")) {
      this.agents.set(
        "codex",
        new CodexAgent(
          config.get<string>("codexCommand", "codex"),
          current.codexThreadId,
          async (threadId) => {
            await this.projectSessions?.updateNativeSession(current.id, "codex", threadId);
            this.publishSessionList();
          },
          this.isCodexRepoTrusted(workspaceRoot),
          async (trusted) => {
            await this.setCodexRepoTrusted(workspaceRoot, trusted);
          },
          this.delegateBridge,
          config.get<string>("delegateBridgeNodeCommand", "node")
        )
      );
    }

    await Promise.all([
      this.orchestrationSession.initialize(),
      ...[...this.agents.values()].map((agent) => agent.initialize(workspaceRoot)),
    ]);
  }

  /** Lets other commands (e.g. "Scan Project") log into the same chat
   * panel instead of only showing a transient notification — the panel
   * doubles as the extension's one activity log. A no-op if the panel
   * hasn't been opened/resolved yet in this window. */
  logScanMessage(text: string): void {
    this.webview?.postMessage({ type: "scan", text } satisfies WebviewOutMessage);
  }

  private async handleUserMessage(text: string, webview: vscode.Webview): Promise<void> {
    if (this.running) {
      webview.postMessage({ type: "error", message: "An agent turn is already running. Stop it before sending another message." } satisfies WebviewOutMessage);
      return;
    }
    this.running = true;
    this.activeTurnInterrupted = false;
    webview.postMessage({ type: "runState", running: true } satisfies WebviewOutMessage);
    const config = vscode.workspace.getConfiguration("orchestratorCode");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) {
      this.running = false;
      webview.postMessage({ type: "runState", running: false } satisfies WebviewOutMessage);
      webview.postMessage({ type: "error", message: "Open a workspace folder before sending a project task." } satisfies WebviewOutMessage);
      return;
    }

    let orchestrationTurnId: string | undefined;
    let delegatedOutput = "";
    let delegatedExitCode = 1;
    try {
      const groqApiKey = await this.secrets.get(ChatViewProvider.groqApiKeySecret);
      if (!groqApiKey) {
        throw new Error(
          'No Groq API key configured. Run "Orchestrator: Set Groq API Key" from the command palette (free key from console.groq.com).'
        );
      }
      await this.initializeSessions();
      const orchestration = this.orchestrationSession!;
      orchestrationTurnId = await orchestration.beginTurn(text);
      const activeProjectSession = this.projectSessions!.current();
      await this.projectSessions!.touch(activeProjectSession.id, text);
      this.publishSessionList();
      const projectContext = orchestration.routingContext(orchestrationTurnId);
      let routingSource = "Groq";
      let decision: RoutingDecision;
      const groqUnavailableUntil = this.workspaceState.get<number>(ChatViewProvider.groqQuotaKey, 0);
      if (groqUnavailableUntil > Date.now()) {
        const fallback = await this.routeWithoutGroq(text, config);
        routingSource = fallback.source;
        decision = fallback.decision;
      } else {
        const router = new GroqRouter(groqApiKey, config.get<string>("groqModel", "llama-3.1-8b-instant"));
        try {
          decision = await router.route(text);
          await this.workspaceState.update(ChatViewProvider.groqQuotaKey, undefined);
        } catch (error) {
          if (!(error instanceof GroqQuotaError) && !(error instanceof GroqRoutingError)) throw error;
          const quotaFailure = error instanceof GroqQuotaError;
          if (quotaFailure) {
            const retryAt = error.retryAt ?? Date.now() + ChatViewProvider.unknownQuotaCooldownMs;
            await this.workspaceState.update(ChatViewProvider.groqQuotaKey, retryAt);
          }
          const fallback = await this.routeWithoutGroq(
            text,
            config,
            quotaFailure ? "Groq quota fallback" : "Groq routing-error fallback"
          );
          routingSource = fallback.source;
          decision = fallback.decision;
        }
      }

      const availableModels = await this.getAllowedModelCatalog(workspaceRoot, config);
      const originallySelectedModel = selectProviderModel(availableModels, decision.agent);
      let selectedAgent = decision.agent;
      let selectedModel = originallySelectedModel;
      let routingReason = `${routingSource} selected ${decision.agent}; the provider's default allowed model will handle the task.`;

      const knownQuotaUntil = this.providerQuotaUntil(selectedAgent);
      if (knownQuotaUntil > Date.now()) {
        const fallbackAgent = alternateAgent(selectedAgent);
        const fallbackQuotaUntil = this.providerQuotaUntil(fallbackAgent);
        if (fallbackQuotaUntil > Date.now()) throw bothProvidersUnavailableError(knownQuotaUntil, fallbackQuotaUntil);
        selectedAgent = fallbackAgent;
        selectedModel = selectEquivalentModel(availableModels, originallySelectedModel, fallbackAgent);
        routingReason = `${routingSource} selected ${decision.agent}, but its quota is unavailable until ${formatResetTime(knownQuotaUntil)}; using ${fallbackAgent} with the equivalent ${describeModelClass(originallySelectedModel)} model class.`;
      }

      await orchestration.recordRouting(
        orchestrationTurnId,
        selectedAgent,
        routingReason,
        undefined,
        selectedModel.id
      );
      webview.postMessage({
        type: "routing",
        agent: selectedAgent,
        model: selectedModel.id,
        reason: routingReason,
      } satisfies WebviewOutMessage);

      const delegatedPrompt = buildDelegatedPrompt(text, projectContext);
      const runAttempt = async (agentId: AgentId, model: AgentModel): Promise<AgentRunResult> => {
        const agent = this.agents.get(agentId)!;
        this.activeAgent = agent;
        webview.postMessage({ type: "runState", running: true, agent: agent.id } satisfies WebviewOutMessage);
        const post = (event: AgentEvent) => {
          if (event.type === "question" || event.type === "permission" || event.type === "elicitation") {
            this.pendingRequestAgents.set(event.id, agent);
          } else if (event.type === "interactionResolved") {
            this.pendingRequestAgents.delete(event.id);
          }
          if (event.type === "text") delegatedOutput = appendBounded(delegatedOutput, event.text);
          if (event.type === "error") delegatedOutput = appendBounded(delegatedOutput, `\nError: ${event.message}`);
          if (event.type === "activity" && event.status !== "started") {
            delegatedOutput = appendBounded(delegatedOutput, `\n[${event.status}] ${event.label}`);
          }
          webview.postMessage({ ...event, agent: agent.id } satisfies WebviewOutMessage);
        };
        const attemptResult = await agent.run({ prompt: delegatedPrompt, cwd: workspaceRoot, model: model.id, onEvent: post });
        this.clearPendingRequestsFor(agent);
        return attemptResult;
      };

      let result = await runAttempt(selectedAgent, selectedModel);
      if (result.exitCode !== 0 && result.failure?.kind === "quota" && !this.activeTurnInterrupted) {
        await this.rememberProviderQuota(selectedAgent, result.failure.retryAt);
        const exhaustedAgent = selectedAgent;
        const exhaustedModel = selectedModel;
        const fallbackAgent = alternateAgent(exhaustedAgent);
        const fallbackQuotaUntil = this.providerQuotaUntil(fallbackAgent);
        if (fallbackQuotaUntil > Date.now()) {
          throw bothProvidersUnavailableError(this.providerQuotaUntil(exhaustedAgent), fallbackQuotaUntil);
        }

        selectedAgent = fallbackAgent;
        selectedModel = selectEquivalentModel(availableModels, exhaustedModel, fallbackAgent);
        routingReason = `${exhaustedAgent} reported an exhausted usage tier; retrying the original task with ${fallbackAgent} on the equivalent ${describeModelClass(exhaustedModel)} model class.`;
        delegatedOutput = appendBounded(delegatedOutput, `\n[quota fallback] ${routingReason}`);
        await orchestration.recordRouting(orchestrationTurnId, selectedAgent, routingReason, undefined, selectedModel.id);
        webview.postMessage({
          type: "routing",
          agent: selectedAgent,
          model: selectedModel.id,
          reason: routingReason,
        } satisfies WebviewOutMessage);
        result = await runAttempt(selectedAgent, selectedModel);
      }

      if (result.exitCode !== 0 && result.failure?.kind === "quota") {
        await this.rememberProviderQuota(selectedAgent, result.failure.retryAt);
        throw new Error(`${selectedAgent} also reported an exhausted usage tier; no coding provider is currently available.`);
      }
      if (result.exitCode === 0) await this.clearProviderQuota(selectedAgent);
      delegatedExitCode = result.exitCode;
      await orchestration.completeTurn(
        orchestrationTurnId,
        result.exitCode,
        delegatedOutput || "The delegated agent returned no textual outcome.",
        this.activeTurnInterrupted
      );
    } catch (err) {
      let message = (err as Error).message;
      if (orchestrationTurnId && this.orchestrationSession) {
        try {
          await this.orchestrationSession.completeTurn(
            orchestrationTurnId,
            delegatedExitCode,
            appendBounded(delegatedOutput, `\nHost error: ${message}`),
            this.activeTurnInterrupted
          );
        } catch (persistError) {
          message += ` (The failed turn could not be saved: ${(persistError as Error).message})`;
        }
      }
      webview.postMessage({ type: "error", message } satisfies WebviewOutMessage);
    } finally {
      for (const [id, owner] of this.pendingRequestAgents) {
        if (owner === this.activeAgent) this.pendingRequestAgents.delete(id);
      }
      this.activeAgent = undefined;
      this.running = false;
      webview.postMessage({ type: "runState", running: false } satisfies WebviewOutMessage);
      await this.startNextQueuedMessage(webview);
    }
  }

  private async getAllowedModelCatalog(
    cwd: string,
    config: vscode.WorkspaceConfiguration
  ): Promise<AgentModel[]> {
    const discovered = (await Promise.all([...this.agents.values()].map((agent) => agent.availableModels(cwd)))).flat();
    const claudeAllowlist = config.get<string[]>("claudeModelAllowlist", ["default", "sonnet", "opus", "haiku"]);
    const codexAllowlist = config.get<string[]>("codexModelAllowlist", []);
    return [
      ...filterModelCatalog(discovered, "claude", claudeAllowlist),
      ...filterModelCatalog(discovered, "codex", codexAllowlist),
    ];
  }

  private async routeWithoutGroq(
    text: string,
    config: vscode.WorkspaceConfiguration,
    fallbackReason = "Groq quota fallback"
  ): Promise<{ decision: RoutingDecision; source: string }> {
    const localRouter = new OllamaRouter(
      config.get<string>("ollamaBaseUrl", "http://localhost:11434"),
      config.get<string>("ollamaModel", "qwen3:8b")
    );
    try {
      return {
        decision: await localRouter.route(text),
        source: `Local Ollama (${fallbackReason})`,
      };
    } catch (localError) {
      const apiKey = await this.secrets.get(ChatViewProvider.ollamaCloudApiKeySecret) ?? process.env.OLLAMA_API_KEY;
      if (!apiKey) {
        throw new Error(
          `${fallbackReason} could not use local Ollama: ${(localError as Error).message} ` +
          'No Ollama Cloud key is configured; run "Orchestrator: Set Ollama Cloud API Key".'
        );
      }

      const cloudRouter = new OllamaCloudRouter(
        apiKey,
        config.get<string>("ollamaCloudBaseUrl", "https://ollama.com"),
        config.get<string>("ollamaCloudModel", "gpt-oss:20b")
      );
      try {
        return {
          decision: await cloudRouter.route(text),
          source: `Ollama Cloud (${fallbackReason}; local Ollama unavailable)`,
        };
      } catch (cloudError) {
        throw new Error(
          `No routing provider is available. Local Ollama: ${(localError as Error).message} ` +
          `Ollama Cloud: ${(cloudError as Error).message}`
        );
      }
    }
  }

  private providerQuotaUntil(agent: AgentId): number {
    const quotas = this.workspaceState.get<Partial<Record<AgentId, number>>>(ChatViewProvider.providerQuotaKey, {});
    const retryAt = quotas[agent];
    return typeof retryAt === "number" && Number.isFinite(retryAt) ? retryAt : 0;
  }

  private async rememberProviderQuota(agent: AgentId, retryAt?: number): Promise<void> {
    const quotas = this.workspaceState.get<Partial<Record<AgentId, number>>>(ChatViewProvider.providerQuotaKey, {});
    const usableRetryAt = typeof retryAt === "number" && retryAt > Date.now()
      ? retryAt
      : Date.now() + ChatViewProvider.unknownQuotaCooldownMs;
    await this.workspaceState.update(ChatViewProvider.providerQuotaKey, { ...quotas, [agent]: usableRetryAt });
  }

  private isCodexRepoTrusted(workspaceRoot: string): boolean {
    const trusted = this.workspaceState.get<string[]>(ChatViewProvider.codexTrustedRepoKey, []);
    return trusted.includes(workspaceRoot);
  }

  private async setCodexRepoTrusted(workspaceRoot: string, trusted: boolean): Promise<void> {
    const current = this.workspaceState.get<string[]>(ChatViewProvider.codexTrustedRepoKey, []);
    const next = trusted
      ? current.includes(workspaceRoot) ? current : [...current, workspaceRoot]
      : current.filter((path) => path !== workspaceRoot);
    await this.workspaceState.update(ChatViewProvider.codexTrustedRepoKey, next);
  }

  private async clearProviderQuota(agent: AgentId): Promise<void> {
    const quotas = { ...this.workspaceState.get<Partial<Record<AgentId, number>>>(ChatViewProvider.providerQuotaKey, {}) };
    if (!(agent in quotas)) return;
    delete quotas[agent];
    await this.workspaceState.update(ChatViewProvider.providerQuotaKey, Object.keys(quotas).length ? quotas : undefined);
  }

  private clearPendingRequestsFor(agent: Agent): void {
    for (const [id, owner] of this.pendingRequestAgents) {
      if (owner === agent) this.pendingRequestAgents.delete(id);
    }
  }

  /**
   * Runs one delegated, ephemeral subtask on `target` and returns its final
   * text — the tool handler `caller`'s own agent instance calls into
   * (`delegate_to_codex` in claudeAgent.ts, `delegate_to_claude` over the
   * socket bridge from codexAgent.ts). Deliberately a brand-new `Agent`
   * instance rather than the persistent `this.agents.get(target)` session:
   * that one is very possibly mid-turn already (`run()` throws if reentered),
   * and a subtask shouldn't fork the visible project session's native
   * conversation/resume state anyway — it's a one-off, gets its own
   * permission prompts routed through the same live webview, and is
   * disposed as soon as it returns.
   */
  private async delegateTask(caller: AgentId, target: AgentId, task: string): Promise<DelegateResult> {
    const webview = this.webview;
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!webview || !workspaceRoot) {
      return { text: "No active orchestrator panel/workspace to run the delegated task in.", exitCode: 1 };
    }
    const config = vscode.workspace.getConfiguration("orchestratorCode");
    const ephemeral: Agent =
      target === "codex" ? new CodexAgent(config.get<string>("codexCommand", "codex")) : new ClaudeAgent();
    const activityId = randomUUID();
    webview.postMessage({
      type: "activity",
      id: activityId,
      kind: "other",
      status: "started",
      label: `${caller} delegated a task to ${target}`,
      detail: task,
      agent: caller,
    } satisfies WebviewOutMessage);

    let text = "";
    const post = (event: AgentEvent) => {
      if (event.type === "question" || event.type === "permission" || event.type === "elicitation") {
        this.pendingRequestAgents.set(event.id, ephemeral);
      } else if (event.type === "interactionResolved") {
        this.pendingRequestAgents.delete(event.id);
      }
      if (event.type === "text") text += event.text;
      if (event.type === "error") text += `\n[error] ${event.message}`;
      if (event.type !== "done") webview.postMessage({ ...event, agent: target } satisfies WebviewOutMessage);
    };
    try {
      const result = await ephemeral.run({ prompt: task, cwd: workspaceRoot, onEvent: post });
      webview.postMessage({
        type: "activity",
        id: activityId,
        kind: "other",
        status: result.exitCode === 0 ? "completed" : "failed",
        label: `${caller} delegated a task to ${target}`,
        detail: task,
        agent: caller,
      } satisfies WebviewOutMessage);
      return { text: text.trim() || "(The delegated turn produced no text output.)", exitCode: result.exitCode };
    } catch (error) {
      webview.postMessage({
        type: "activity",
        id: activityId,
        kind: "other",
        status: "failed",
        label: `${caller} delegated a task to ${target}`,
        detail: (error as Error).message,
        agent: caller,
      } satisfies WebviewOutMessage);
      throw error;
    } finally {
      this.clearPendingRequestsFor(ephemeral);
      await ephemeral.dispose();
    }
  }

  private enqueueMessage(text: string, webview: vscode.Webview): void {
    const message = text.trim();
    if (!message) return;
    if (this.queuedMessages.length >= 50) {
      webview.postMessage({ type: "error", message: "The message queue is full (50 items)." } satisfies WebviewOutMessage);
      return;
    }
    this.queuedMessages.push(message);
    this.publishQueueState();
    webview.postMessage({
      type: "composerNotice",
      status: "queued",
      message: `Queued for the next turn (${this.queuedMessages.length} waiting).`,
    } satisfies WebviewOutMessage);
    if (!this.running) void this.startNextQueuedMessage(webview);
  }

  private async steerActiveTurn(text: string, webview: vscode.Webview): Promise<void> {
    const message = text.trim();
    if (!message) return;
    const agent = this.activeAgent;
    if (!this.running) {
      await this.handleUserMessage(message, webview);
      return;
    }
    if (!agent) {
      this.enqueueMessage(message, webview);
      return;
    }
    try {
      if (await agent.steer(message)) {
        webview.postMessage({
          type: "composerNotice",
          status: "steered",
          message: `Sent immediately to the active ${agent.id} turn.`,
        } satisfies WebviewOutMessage);
        return;
      }
    } catch (error) {
      webview.postMessage({
        type: "error",
        message: `Instant send missed the active turn and was queued instead: ${(error as Error).message}`,
      } satisfies WebviewOutMessage);
    }
    this.enqueueMessage(message, webview);
  }

  private async startNextQueuedMessage(webview: vscode.Webview): Promise<void> {
    if (this.running || this.webview !== webview) return;
    const next = this.queuedMessages.shift();
    this.publishQueueState();
    if (!next) return;
    webview.postMessage({
      type: "composerNotice",
      status: "started",
      message: "Starting the next queued message.",
    } satisfies WebviewOutMessage);
    await this.handleUserMessage(next, webview);
  }

  private publishQueueState(): void {
    this.webview?.postMessage({
      type: "queueState",
      count: this.queuedMessages.length,
    } satisfies WebviewOutMessage);
  }

  private async createProjectSession(webview: vscode.Webview): Promise<void> {
    if (this.running) {
      webview.postMessage({ type: "error", message: "Stop the active agent turn before creating a new session." } satisfies WebviewOutMessage);
      this.publishSessionList();
      return;
    }
    try {
      await this.initializeSessions();
      await this.projectSessions!.create();
      await this.reloadActiveProjectSession(webview);
    } catch (error) {
      webview.postMessage({ type: "sessionStatus", status: "error", message: (error as Error).message } satisfies WebviewOutMessage);
      this.publishSessionList();
    }
  }

  private async switchProjectSession(id: string, webview: vscode.Webview): Promise<void> {
    if (this.running) {
      webview.postMessage({ type: "error", message: "Stop the active agent turn before switching sessions." } satisfies WebviewOutMessage);
      this.publishSessionList();
      return;
    }
    try {
      await this.initializeSessions();
      if (this.projectSessions!.current().id === id) {
        this.publishSessionList();
        return;
      }
      await this.projectSessions!.activate(id);
      await this.reloadActiveProjectSession(webview);
    } catch (error) {
      webview.postMessage({ type: "sessionStatus", status: "error", message: (error as Error).message } satisfies WebviewOutMessage);
      this.publishSessionList();
    }
  }

  private async reloadActiveProjectSession(webview: vscode.Webview): Promise<void> {
    webview.postMessage({ type: "sessionStatus", status: "loading", message: "Switching project session…" } satisfies WebviewOutMessage);
    await Promise.all([...this.agents.values()].map((agent) => agent.dispose()));
    this.agents.clear();
    this.pendingRequestAgents.clear();
    this.activeAgent = undefined;
    this.orchestrationSession = undefined;
    this.sessionsReady = undefined;
    await this.initializeSessions();
    this.publishSessionList();
    webview.postMessage({ type: "sessionStatus", status: "ready", message: "Selected Claude and Codex sessions are ready." } satisfies WebviewOutMessage);
  }

  private publishSessionList(): void {
    if (!this.projectSessions || !this.webview) return;
    const active = this.projectSessions.current();
    this.webview.postMessage({
      type: "sessionList",
      activeSessionId: active.id,
      sessions: this.projectSessions.list(),
    } satisfies WebviewOutMessage);
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
    const nonce = String(Date.now());

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Orchestrator Chat</title>
</head>
<body>
  <section class="session-panel" aria-labelledby="session-picker-label">
    <div class="session-panel-header">
      <label id="session-picker-label" for="session-picker">Project session</label>
      <button id="scan-project" type="button" class="toolbar-action" title="Scan this workspace into the shared code graph">Scan project</button>
    </div>
    <div class="session-picker-row">
      <select id="session-picker" aria-label="Project session" title="Switch the linked orchestrator, Claude and Codex session"></select>
      <button id="new-session" type="button" class="secondary" title="Start a new linked project session" aria-label="Start a new linked project session">
        <span aria-hidden="true">＋</span>
        <span>New</span>
      </button>
    </div>
    <div id="session-detail" class="session-detail"></div>
  </section>
  <div id="usage-panel" class="usage-panel" hidden></div>
  <div id="log"></div>
  <form id="composer">
    <textarea id="input" placeholder="Describe the task..." rows="3"></textarea>
    <div class="composer-actions">
      <button id="stop" type="button" class="secondary" hidden>Stop</button>
      <button id="queue" type="button" class="secondary" hidden>Queue</button>
      <button id="send" type="submit"><span class="send-spinner" aria-hidden="true"></span><span class="send-label">Send</span></button>
    </div>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

function appendBounded(current: string, addition: string, maxChars = 12_000): string {
  const combined = current + addition;
  return combined.length <= maxChars ? combined : combined.slice(-maxChars);
}

function buildDelegatedPrompt(userTask: string, projectContext: string): string {
  return [
    "The workspace orchestrator delegated this task to you:",
    userTask,
    "",
    "Shared project context from earlier Claude/Codex turns follows. Treat the current workspace as the source of truth:",
    projectContext,
  ].join("\n");
}

function filterModelCatalog(
  catalog: AgentModel[],
  agent: AgentId,
  allowlist: string[]
): AgentModel[] {
  const providerModels = catalog.filter((model) => model.agent === agent);
  if (allowlist.length === 0) return providerModels;
  const allowed = new Set(allowlist);
  const filtered = providerModels.filter((model) => allowed.has(model.id));
  return filtered.length ? filtered : providerModels.filter((model) => model.isDefault).slice(0, 1);
}

function selectProviderModel(catalog: AgentModel[], agent: AgentId): AgentModel {
  const providerModels = catalog.filter((model) => model.agent === agent);
  const selected = providerModels.find((model) => model.isDefault) ?? providerModels[0];
  if (!selected) throw new Error(`No allowed ${agent} model is available.`);
  return selected;
}

function formatResetTime(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function bothProvidersUnavailableError(claudeOrCodexReset: number, otherReset: number): Error {
  const nextReset = Math.min(...[claudeOrCodexReset, otherReset].filter((value) => value > Date.now()));
  return new Error(
    Number.isFinite(nextReset)
      ? `Both Claude and Codex usage tiers are exhausted. The next known reset is ${formatResetTime(nextReset)}.`
      : "Both Claude and Codex usage tiers are exhausted."
  );
}

function safeExternalUri(value: string): vscode.Uri | undefined {
  try {
    const uri = vscode.Uri.parse(value, true);
    return uri.scheme === "https" || uri.scheme === "http" ? uri : undefined;
  } catch {
    return undefined;
  }
}

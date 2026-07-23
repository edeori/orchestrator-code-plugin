import { randomUUID } from "crypto";
import { createSdkMcpServer, getSessionInfo, query, tool, USAGE_LIMIT_ERROR_PREFIXES } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanUseTool,
  EffortLevel,
  PermissionResult,
  PermissionRuleValue,
  Query,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { Agent, AgentModel, AgentQuotaFailure, AgentRunOptions, AgentRunResult } from "./agent";
import type { AgentEvent, ElicitationResponse, PermissionDecision } from "./agentEvent";
import type { DelegateResult } from "./delegateBridge";

/**
 * Read-only/low-risk tools that never prompt — everything else (Bash,
 * Write, Edit, ...) goes through the permission dialog, same spirit as
 * Claude Code's own default permission set, just hardcoded rather than
 * configurable for this v1.
 */
const AUTO_ALLOW_TOOLS = new Set(["Read", "Grep", "Glob", "WebSearch", "TodoWrite"]);

/**
 * Drives a Claude Code session via the Claude Agent SDK (`query()`)
 * instead of spawning the `claude` CLI as a dumb subprocess and parsing
 * its stdout — this is what makes real interactive questions/permission
 * prompts and a live rate-limit gauge possible at all, matching the same
 * experience the real Claude Code chat gives. See agentEvent.ts for the
 * event shapes this emits; ChatViewProvider owns turning them into UI.
 */
export class ClaudeAgent implements Agent {
  readonly id = "claude" as const;

  private pendingQuestions = new Map<string, (answers: Record<string, string[]>) => void>();
  private pendingPermissions = new Map<string, (decision: PermissionDecision) => void>();
  private pendingElicitations = new Map<string, (response: ElicitationResponse) => void>();
  private sessionApprovedTools = new Set<string>();
  private sessionId: string | undefined;
  private currentQuery: Query | undefined;
  private currentInput: PushableAsyncIterable<SDKUserMessage> | undefined;
  private eventSink: AgentRunOptions["onEvent"] | undefined;
  private disposed = false;
  private sessionNeedsValidation: boolean;
  private modelCatalog: AgentModel[] | undefined;
  private modelCatalogReady: Promise<AgentModel[]> | undefined;

  constructor(
    initialSessionId?: string,
    private readonly onSessionIdChanged?: (sessionId: string | undefined) => void | Promise<void>,
    /** Lets this Claude turn hand a subtask to a fresh Codex turn — exposed as an in-process `delegate_to_codex` tool below. Omitted disables the tool. */
    private readonly delegateToCodex?: (task: string) => Promise<DelegateResult>
  ) {
    this.sessionId = initialSessionId;
    this.sessionNeedsValidation = Boolean(initialSessionId);
  }

  answerQuestion(id: string, answers: Record<string, string[]>): void {
    this.pendingQuestions.get(id)?.(answers);
    this.pendingQuestions.delete(id);
    this.eventSink?.({ type: "interactionResolved", id, resolution: "answered" });
  }

  resolvePermission(id: string, decision: PermissionDecision): void {
    this.pendingPermissions.get(id)?.(decision);
    this.pendingPermissions.delete(id);
    this.eventSink?.({ type: "interactionResolved", id, resolution: decision === "deny" ? "denied" : "answered" });
  }

  resolveElicitation(id: string, response: ElicitationResponse): void {
    this.pendingElicitations.get(id)?.(response);
    this.pendingElicitations.delete(id);
    this.eventSink?.({
      type: "interactionResolved",
      id,
      resolution: response.action === "accept" ? "answered" : response.action === "decline" ? "denied" : "cancelled",
    });
  }

  async initialize(cwd: string): Promise<void> {
    if (this.disposed) throw new Error("The Claude session has already been disposed.");
    await this.validateRestoredSession(cwd);
    await this.availableModels(cwd);
  }

  availableModels(cwd: string): Promise<AgentModel[]> {
    if (this.modelCatalog) return Promise.resolve(this.modelCatalog);
    if (this.modelCatalogReady) return this.modelCatalogReady;
    this.modelCatalogReady = this.discoverModels(cwd)
      .catch(() => [defaultClaudeModel()])
      .then((models) => {
        this.modelCatalog = models.length ? models : [defaultClaudeModel()];
        return this.modelCatalog;
      })
      .finally(() => {
        this.modelCatalogReady = undefined;
      });
    return this.modelCatalogReady;
  }

  async run({ prompt, cwd, model, effort, onEvent }: AgentRunOptions): Promise<AgentRunResult> {
    if (this.disposed) throw new Error("The Claude session has already been disposed.");
    if (this.currentQuery) throw new Error("Claude is already handling another turn.");
    this.eventSink = onEvent;
    await this.initialize(cwd);
    const toolActivities = new Map<string, ClaudeToolActivity>();
    const canUseTool: CanUseTool = async (toolName, input, options): Promise<PermissionResult> => {
      if (AUTO_ALLOW_TOOLS.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }

      if (toolName === "AskUserQuestion") {
        const id = randomUUID();
        const rawQuestions = (input.questions as Array<Record<string, unknown>> | undefined) ?? [];
        const questions = rawQuestions.map((q, i) => ({
          id: typeof q.id === "string" ? q.id : String(i),
          header: typeof q.header === "string" ? q.header : "",
          question: typeof q.question === "string" ? q.question : "",
          multiSelect: q.multiSelect === true,
          options: ((q.options as Array<Record<string, unknown>> | undefined) ?? []).map((o) => ({
            label: String(o.label ?? ""),
            description: String(o.description ?? ""),
          })),
        }));
        onEvent({ type: "question", id, questions, autoResolutionMs: null });
        const answersById = await new Promise<Record<string, string[]>>((resolve) => {
          this.pendingQuestions.set(id, resolve);
          options.signal.addEventListener(
            "abort",
            () => {
              if (!this.pendingQuestions.delete(id)) return;
              resolve({});
              onEvent({ type: "interactionResolved", id, resolution: "cancelled" });
            },
            { once: true }
          );
        });
        // AskUserQuestionOutput's real shape (sdk-tools.d.ts, verified live
        // against a real session — an earlier attempt keying by an
        // invented per-question id was silently ignored by the model):
        // `answers` is keyed by the question's full TEXT, not an id/header,
        // and multi-select answers are a single comma-joined string, not
        // an array.
        const answers: Record<string, string> = {};
        for (const q of questions) {
          answers[q.question] = (answersById[q.id] ?? []).join(", ");
        }
        return { behavior: "allow", updatedInput: { questions: rawQuestions, answers } };
      }

      if (this.sessionApprovedTools.has(toolName)) {
        return { behavior: "allow", updatedInput: input };
      }

      const id = randomUUID();
      onEvent({
        type: "permission",
        id,
        kind: "tool",
        title: options.title ?? `Claude wants to use ${toolName}`,
        description: options.description ?? JSON.stringify(input),
        availableDecisions: ["allow-once", "allow-session", "allow-repo", "deny"],
      });
      const decision = await new Promise<PermissionDecision>((resolve) => {
        this.pendingPermissions.set(id, resolve);
        options.signal.addEventListener(
          "abort",
          () => {
            if (!this.pendingPermissions.delete(id)) return;
            resolve("deny");
            onEvent({ type: "interactionResolved", id, resolution: "cancelled" });
          },
          { once: true }
        );
      });

      if (decision === "deny") {
        return { behavior: "deny", message: "Denied by user." };
      }
      if (decision === "allow-session" || decision === "allow-repo") {
        // "allow-repo" writes the rule to `.claude/settings.local.json` in
        // the scanned project (destination 'localSettings') instead of only
        // holding it in memory for this process ('session') — the SDK's own
        // persistence mechanism, same file the real Claude Code CLI's
        // "always allow" writes to. See the settingSources note below for
        // why that file is now actually loaded back.
        const destination = decision === "allow-repo" ? "localSettings" : "session";
        if (options.suggestions?.length) {
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: options.suggestions.map((suggestion) => ({
              ...suggestion,
              destination,
            })),
          };
        }
        if (decision === "allow-repo") {
          const rule: PermissionRuleValue = { toolName };
          return {
            behavior: "allow",
            updatedInput: input,
            updatedPermissions: [{ type: "addRules", rules: [rule], behavior: "allow", destination }],
          };
        }
        this.sessionApprovedTools.add(toolName);
      }
      return { behavior: "allow", updatedInput: input };
    };

    const onElicitation = async (
      request: {
        serverName: string;
        message: string;
        mode?: "form" | "url";
        url?: string;
        requestedSchema?: Record<string, unknown>;
        title?: string;
      },
      options: { signal: AbortSignal }
    ): Promise<ElicitationResponse> => {
      const id = randomUUID();
      onEvent({
        type: "elicitation",
        id,
        serverName: request.serverName,
        mode: request.mode === "url" ? "url" : "form",
        message: request.message,
        title: request.title,
        schema: request.requestedSchema,
        url: request.url,
      });
      return new Promise<ElicitationResponse>((resolve) => {
        this.pendingElicitations.set(id, resolve);
        options.signal.addEventListener(
          "abort",
          () => {
            if (!this.pendingElicitations.delete(id)) return;
            resolve({ action: "cancel" });
            onEvent({ type: "interactionResolved", id, resolution: "cancelled" });
          },
          { once: true }
        );
      });
    };

    let exitCode = 0;
    let quotaFailure: AgentQuotaFailure | undefined;
    const input = new PushableAsyncIterable<SDKUserMessage>();
    input.push(claudeUserMessage(prompt));
    this.currentInput = input;
    try {
      const stream = query({
        prompt: input,
        options: {
          cwd,
          includePartialMessages: true,
          canUseTool,
          onElicitation,
          // Forced explicitly rather than inherited from whatever the
          // user's own ~/.claude/settings.json happens to say (e.g. a
          // pre-existing "auto" mode + Bash allow-rule, confirmed live on
          // this exact machine to skip canUseTool entirely) — the whole
          // point of building a custom permission UI is for decisions to
          // actually go through it, consistently, regardless of the
          // user's separate interactive-CLI settings.
          permissionMode: "default",
          // Excludes 'user' so a personal, machine-wide allow-rule can't
          // silently bypass our own canUseTool — confirmed live: without
          // excluding it, Bash never triggered a permission event at all on
          // this machine. Keeps 'project' so CLAUDE.md files in the scanned
          // repo still load. Includes 'local' (.claude/settings.local.json,
          // gitignored, per-project) deliberately: it's the destination the
          // "allow-repo" permission decision above writes to, and it's the
          // exact same file/scope the real Claude Code CLI's own "always
          // allow" writes to — so a rule approved once here (or already
          // approved via a plain `claude` session on this repo) stops
          // prompting for good, without widening the bypass to other repos
          // or other tools the user never actually approved.
          settingSources: ["project", "local"],
          ...(this.delegateToCodex ? { mcpServers: { orchestrator: this.buildDelegateMcpServer() } } : {}),
          ...(model ? { model } : {}),
          ...(isClaudeEffort(effort) ? { effort } : {}),
          ...(this.sessionId ? { resume: this.sessionId } : {}),
        },
      });
      this.currentQuery = stream;
      for await (const message of stream) {
        if (typeof message.session_id === "string" && message.session_id !== this.sessionId) {
          this.sessionId = message.session_id;
          await this.onSessionIdChanged?.(message.session_id);
        }
        switch (message.type) {
          case "assistant": {
            if (message.error === "rate_limit") {
              quotaFailure ??= { kind: "quota", message: "Claude reported that its usage limit was reached." };
            }
            for (const started of claudeToolStarts(message.message.content)) {
              if (toolActivities.has(started.id)) continue;
              toolActivities.set(started.id, started.activity);
              onEvent({
                type: "activity",
                id: started.id,
                status: "started",
                ...started.activity,
              });
            }
            break;
          }
          case "user": {
            for (const result of claudeToolResults(message.message.content)) {
              const activity = toolActivities.get(result.id);
              if (!activity) continue;
              onEvent({
                type: "activity",
                id: result.id,
                status: result.failed ? "failed" : "completed",
                ...activity,
              });
              toolActivities.delete(result.id);
            }
            break;
          }
          case "tool_progress": {
            const activity = toolActivities.get(message.tool_use_id);
            if (activity && message.elapsed_time_seconds >= 1) {
              onEvent({
                type: "activity",
                id: message.tool_use_id,
                status: "started",
                ...activity,
                detail: activity.detail
                  ? `${activity.detail} · ${Math.round(message.elapsed_time_seconds)}s`
                  : `${Math.round(message.elapsed_time_seconds)}s`,
              });
            }
            break;
          }
          case "stream_event": {
            const event = message.event as unknown as {
              type?: string;
              delta?: { type?: string; text?: string };
            };
            if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
              onEvent({ type: "text", text: event.delta.text });
            }
            break;
          }
          case "rate_limit_event": {
            const info = message.rate_limit_info;
            if (info?.status === "rejected" || info?.errorCode === "credits_required") {
              quotaFailure = {
                kind: "quota",
                message: "Claude usage or credits are exhausted.",
                retryAt: normalizeProviderTimestamp(info.resetsAt ?? info.overageResetsAt),
              };
              exitCode = 1;
            }
            if (info?.rateLimitType === "five_hour" && typeof info.utilization === "number") {
              onEvent({
                type: "usage",
                rateLimits: [
                  {
                    id: "claude:five-hour",
                    label: "Claude · 5h",
                    usedPercent: info.utilization,
                    windowDurationMinutes: 300,
                    resetsAt: info.resetsAt ?? null,
                  },
                ],
              });
            }
            break;
          }
          case "result": {
            input.close();
            if ("total_cost_usd" in message) {
              onEvent({ type: "usage", costUsd: message.total_cost_usd });
            }
            if (message.is_error) {
              exitCode = 1;
            }
            const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
            const quotaMessage = errors.find(isClaudeUsageLimitMessage);
            if (message.terminal_reason === "blocking_limit" || quotaMessage) {
              quotaFailure ??= {
                kind: "quota",
                message: quotaMessage ?? "Claude reported a blocking usage limit.",
              };
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      const message = (err as Error).message;
      onEvent({ type: "error", message });
      if (isClaudeUsageLimitMessage(message)) {
        quotaFailure ??= { kind: "quota", message };
      }
      exitCode = 1;
    } finally {
      input.close();
      this.currentInput = undefined;
      this.currentQuery = undefined;
    }

    onEvent({ type: "done", exitCode });
    return { exitCode, failure: exitCode === 0 ? undefined : quotaFailure };
  }

  async interrupt(): Promise<void> {
    const active = this.currentQuery;
    if (!active) return;
    try {
      await active.interrupt();
    } catch {
      active.close();
    }
  }

  async steer(text: string): Promise<boolean> {
    if (!this.currentQuery || !this.currentInput || !text.trim()) return false;
    return this.currentInput.push(claudeUserMessage(text.trim()));
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const [id, resolve] of this.pendingQuestions) {
      resolve({});
      this.eventSink?.({ type: "interactionResolved", id, resolution: "cancelled" });
    }
    this.pendingQuestions.clear();
    for (const [id, resolve] of this.pendingPermissions) {
      resolve("deny");
      this.eventSink?.({ type: "interactionResolved", id, resolution: "cancelled" });
    }
    this.pendingPermissions.clear();
    for (const [id, resolve] of this.pendingElicitations) {
      resolve({ action: "cancel" });
      this.eventSink?.({ type: "interactionResolved", id, resolution: "cancelled" });
    }
    this.pendingElicitations.clear();
    this.currentQuery?.close();
    this.currentInput?.close();
    this.currentInput = undefined;
    this.currentQuery = undefined;
  }

  /**
   * In-process MCP server (no subprocess, no network — the SDK just routes
   * tool calls straight to this callback) exposing one tool, `delegate_to_codex`,
   * so this same Claude turn can hand off a subtask to a fresh Codex turn and
   * get its final answer back as text. Only built when the caller actually
   * wired up a `delegateToCodex` implementation (see ChatViewProvider), so a
   * Claude session never advertises a tool that would just fail.
   */
  private buildDelegateMcpServer() {
    return createSdkMcpServer({
      name: "orchestrator",
      version: "1.0.0",
      tools: [
        tool(
          "delegate_to_codex",
          "Hands a subtask to a fresh Codex turn in this same project and returns its final answer as text. " +
            "Use this for anything Codex is specifically strong at, or simply to get a second model's take on " +
            "part of the task. The delegated turn runs independently: it does not see this conversation's " +
            "history, so include everything it needs to know in the task text.",
          { task: z.string().min(1).describe("Full, self-contained description of the subtask for Codex to carry out.") },
          async ({ task }) => {
            try {
              const result = await this.delegateToCodex!(task);
              const suffix = result.exitCode !== 0 ? "\n\n[Codex's delegated turn ended with an error.]" : "";
              return { content: [{ type: "text" as const, text: `${result.text}${suffix}` }] };
            } catch (error) {
              return {
                content: [{ type: "text" as const, text: `Delegation to Codex failed: ${(error as Error).message}` }],
                isError: true,
              };
            }
          }
        ),
      ],
    });
  }

  private async validateRestoredSession(cwd: string): Promise<void> {
    if (!this.sessionNeedsValidation || !this.sessionId) return;
    this.sessionNeedsValidation = false;
    try {
      const info = await getSessionInfo(this.sessionId, { dir: cwd });
      if (info) return;
    } catch {
      // Preserve the id on transient/local read errors. The SDK's resume path
      // will report the real failure rather than silently losing continuity.
      return;
    }
    // A confirmed missing session is safe to replace before the new prompt
    // has been submitted to a model.
    this.sessionId = undefined;
    await this.onSessionIdChanged?.(undefined);
  }

  /**
   * Opens only the SDK control channel and deliberately never submits a user
   * prompt. This gives us the account/policy-aware model catalog without
   * creating a throwaway Claude conversation or consuming a model turn.
   */
  private async discoverModels(cwd: string): Promise<AgentModel[]> {
    const abortController = new AbortController();
    async function* idleInput(): AsyncGenerator<never, void, unknown> {
      await new Promise<void>((resolve) => abortController.signal.addEventListener("abort", () => resolve(), { once: true }));
    }

    const probe = query({
      prompt: idleInput(),
      options: {
        cwd,
        abortController,
        persistSession: false,
        permissionMode: "default",
        settingSources: ["project"],
      },
    });
    try {
      const models = await withTimeout(probe.supportedModels(), 20_000, "Claude model discovery timed out.");
      return models.map((model, index) => ({
        agent: "claude" as const,
        id: model.value,
        displayName: model.displayName,
        description: model.description,
        isDefault: model.value === "default" || index === 0,
        supportedEfforts: model.supportedEffortLevels ? [...model.supportedEffortLevels] : [],
      }));
    } finally {
      abortController.abort();
      probe.close();
    }
  }
}

function claudeUserMessage(text: string): SDKUserMessage {
  return {
    type: "user",
    message: {
      role: "user",
      content: [{ type: "text", text }],
    },
    parent_tool_use_id: null,
  };
}

class PushableAsyncIterable<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<(result: IteratorResult<T>) => void> = [];
  private closed = false;

  push(value: T): boolean {
    if (this.closed) return false;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value, done: false });
    else this.values.push(value);
    return true;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.values.shift();
        if (value !== undefined) return Promise.resolve({ value, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

type ClaudeToolActivity = Pick<Extract<AgentEvent, { type: "activity" }>, "kind" | "label" | "detail">;

function claudeToolStarts(content: unknown): Array<{ id: string; activity: ClaudeToolActivity }> {
  if (!Array.isArray(content)) return [];
  const starts: Array<{ id: string; activity: ClaudeToolActivity }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "tool_use" || typeof record.id !== "string" || typeof record.name !== "string") continue;
    starts.push({
      id: record.id,
      activity: describeClaudeTool(record.name, asRecord(record.input)),
    });
  }
  return starts;
}

function claudeToolResults(content: unknown): Array<{ id: string; failed: boolean }> {
  if (!Array.isArray(content)) return [];
  const results: Array<{ id: string; failed: boolean }> = [];
  for (const block of content) {
    const record = asRecord(block);
    if (record?.type !== "tool_result" || typeof record.tool_use_id !== "string") continue;
    results.push({ id: record.tool_use_id, failed: record.is_error === true });
  }
  return results;
}

function describeClaudeTool(name: string, input: Record<string, unknown> | undefined): ClaudeToolActivity {
  if (name === "Bash") {
    return { kind: "command", label: "Run command", detail: shortString(input?.command) };
  }
  if (["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(name)) {
    return {
      kind: "fileChange",
      label: `${name} file`,
      detail: shortString(input?.file_path ?? input?.notebook_path),
    };
  }
  if (name === "Read") {
    return { kind: "other", label: "Read file", detail: shortString(input?.file_path) };
  }
  if (name === "Grep") {
    return {
      kind: "other",
      label: "Search text",
      detail: joinDetails(input?.pattern, input?.path),
    };
  }
  if (name === "Glob") {
    return {
      kind: "other",
      label: "Find files",
      detail: joinDetails(input?.pattern, input?.path),
    };
  }
  if (name === "WebSearch" || name === "WebFetch") {
    return {
      kind: "webSearch",
      label: name === "WebSearch" ? "Search the web" : "Fetch web page",
      detail: shortString(input?.query ?? input?.url),
    };
  }
  if (name.startsWith("mcp__")) {
    const [, server, ...toolParts] = name.split("__");
    return {
      kind: "mcp",
      label: `MCP · ${server || "server"} / ${toolParts.join("__") || "tool"}`,
    };
  }
  if (name === "Task" || name === "Agent") {
    return { kind: "other", label: "Delegate subtask", detail: shortString(input?.description) };
  }
  return { kind: "other", label: name };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

function shortString(value: unknown, maxLength = 240): string | undefined {
  if (typeof value !== "string") return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

function joinDetails(...values: unknown[]): string | undefined {
  const parts = values.map((value) => shortString(value, 120)).filter((value): value is string => Boolean(value));
  return parts.length ? parts.join(" · ") : undefined;
}

function isClaudeUsageLimitMessage(message: string): boolean {
  const trimmed = message.trim();
  return USAGE_LIMIT_ERROR_PREFIXES.some((prefix) => trimmed.startsWith(prefix));
}

function normalizeProviderTimestamp(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return value < 10_000_000_000 ? value * 1_000 : value;
}

function defaultClaudeModel(): AgentModel {
  return {
    agent: "claude",
    id: "default",
    displayName: "Claude default",
    description: "The default model selected by the authenticated Claude Code account.",
    isDefault: true,
    supportedEfforts: [],
  };
}

function isClaudeEffort(value: string | undefined): value is EffortLevel {
  return value === "low" || value === "medium" || value === "high" || value === "xhigh" || value === "max";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

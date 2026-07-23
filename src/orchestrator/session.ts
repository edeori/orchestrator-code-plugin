import { randomUUID } from "crypto";
import type { AgentId } from "../agents/agent";

interface StateStore {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

export interface OrchestrationTurn {
  id: string;
  userTask: string;
  status: "routing" | "running" | "completed" | "failed" | "interrupted";
  agent?: AgentId;
  model?: string;
  effort?: string;
  complexity?: "simple" | "routine" | "hard";
  reason?: string;
  outcome?: string;
  exitCode?: number;
  startedAt: number;
  completedAt?: number;
}

export interface OrchestrationState {
  version: 1;
  id: string;
  projectRoot: string;
  projectSummary: string;
  turns: OrchestrationTurn[];
}

const LEGACY_STATE_KEY = "orchestratorCode.orchestrationSession.v1";
const SESSION_STATE_PREFIX = "orchestratorCode.orchestrationSession.v2.";
const SESSION_REGISTRY_KEY = "orchestratorCode.projectSessions.v2";
const LEGACY_CLAUDE_SESSION_KEY = "orchestratorCode.session.claude";
const LEGACY_CODEX_THREAD_KEY = "orchestratorCode.session.codex";
const MAX_STORED_TURNS = 60;
const MAX_OUTCOME_CHARS = 8_000;
const MAX_ROUTING_CONTEXT_CHARS = 14_000;

/** Workspace-scoped durable memory owned by the extension host. */
export class OrchestrationSession {
  private state: OrchestrationState;

  constructor(
    private readonly store: StateStore,
    projectRoot: string,
    sessionId?: string
  ) {
    const id = sessionId ?? randomUUID();
    this.stateKey = `${SESSION_STATE_PREFIX}${id}`;
    const restored = store.get<OrchestrationState>(this.stateKey);
    this.state = isValidState(restored, projectRoot)
      ? restored
      : {
          version: 1,
          id,
          projectRoot,
          projectSummary: "",
          turns: [],
        };
  }

  private readonly stateKey: string;

  get id(): string {
    return this.state.id;
  }

  async initialize(): Promise<void> {
    const now = Date.now();
    for (const turn of this.state.turns) {
      if (turn.status !== "routing" && turn.status !== "running") continue;
      turn.status = "interrupted";
      turn.completedAt = now;
      turn.outcome ||= "The extension host restarted before this delegated turn reported a final outcome.";
    }
    await this.persist();
  }

  async beginTurn(userTask: string): Promise<string> {
    const id = randomUUID();
    this.state.turns.push({
      id,
      userTask,
      status: "routing",
      startedAt: Date.now(),
    });
    this.trim();
    await this.persist();
    return id;
  }

  async recordRouting(
    turnId: string,
    agent: AgentId,
    reason: string,
    projectSummary?: string,
    model?: string,
    effort?: string,
    complexity?: "simple" | "routine" | "hard"
  ): Promise<void> {
    const turn = this.find(turnId);
    turn.agent = agent;
    turn.model = model;
    turn.effort = effort;
    turn.complexity = complexity;
    turn.reason = reason;
    turn.status = "running";
    if (projectSummary?.trim()) this.state.projectSummary = projectSummary.trim().slice(0, MAX_ROUTING_CONTEXT_CHARS);
    await this.persist();
  }

  async completeTurn(turnId: string, exitCode: number, outcome: string, interrupted = false): Promise<void> {
    const turn = this.find(turnId);
    turn.exitCode = exitCode;
    turn.outcome = outcome.trim().slice(-MAX_OUTCOME_CHARS);
    turn.completedAt = Date.now();
    turn.status = interrupted ? "interrupted" : exitCode === 0 ? "completed" : "failed";
    await this.persist();
  }

  routingContext(currentTurnId: string): string {
    const header = [
      `Orchestrator session: ${this.state.id}`,
      `Workspace: ${this.state.projectRoot}`,
      this.state.projectSummary ? `Durable project summary:\n${this.state.projectSummary}` : "Durable project summary: not established yet.",
      "Recent delegated work:",
    ].join("\n");

    const available = Math.max(1_000, MAX_ROUTING_CONTEXT_CHARS - header.length);
    const blocks: string[] = [];
    let used = 0;
    for (const turn of [...this.state.turns].reverse()) {
      if (turn.id === currentTurnId) continue;
      const block = [
        `Task: ${turn.userTask}`,
        `Agent: ${turn.agent ?? "not routed"}`,
        turn.model ? `Model: ${turn.model}${turn.effort ? ` (${turn.effort} effort)` : ""}` : "",
        turn.complexity ? `Task class: ${turn.complexity}` : "",
        `Status: ${turn.status}`,
        turn.reason ? `Routing reason: ${turn.reason}` : "",
        turn.outcome ? `Agent outcome:\n${turn.outcome}` : "Agent outcome: unavailable (the host may have restarted mid-turn).",
      ]
        .filter(Boolean)
        .join("\n");
      if (used + block.length > available) break;
      blocks.unshift(block);
      used += block.length;
    }
    return `${header}\n${blocks.join("\n\n---\n\n") || "No previous delegated work."}`;
  }

  private find(turnId: string): OrchestrationTurn {
    const turn = this.state.turns.find((candidate) => candidate.id === turnId);
    if (!turn) throw new Error(`Unknown orchestrator turn: ${turnId}`);
    return turn;
  }

  private trim(): void {
    if (this.state.turns.length > MAX_STORED_TURNS) {
      this.state.turns = this.state.turns.slice(-MAX_STORED_TURNS);
    }
  }

  private async persist(): Promise<void> {
    await this.store.update(this.stateKey, this.state);
  }
}

export interface ProjectSessionSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  claudeSessionId?: string;
  codexThreadId?: string;
}

interface ProjectSessionRegistry {
  version: 2;
  projectRoot: string;
  activeSessionId: string;
  sessions: ProjectSessionSummary[];
}

/**
 * Groups the local orchestration history and the two provider-native
 * conversations into one user-selectable project session.
 */
export class ProjectSessionManager {
  private registry: ProjectSessionRegistry | undefined;

  constructor(
    private readonly store: StateStore,
    private readonly projectRoot: string
  ) {}

  async initialize(): Promise<void> {
    if (this.registry) return;
    const restored = this.store.get<ProjectSessionRegistry>(SESSION_REGISTRY_KEY);
    if (isValidRegistry(restored, this.projectRoot)) {
      this.registry = restored;
      return;
    }

    const legacy = this.store.get<OrchestrationState>(LEGACY_STATE_KEY);
    const id = isValidState(legacy, this.projectRoot) ? legacy.id : randomUUID();
    const now = Date.now();
    const firstTask = isValidState(legacy, this.projectRoot)
      ? legacy.turns.find((turn) => turn.userTask.trim())?.userTask
      : undefined;
    const session: ProjectSessionSummary = {
      id,
      title: sessionTitle(firstTask),
      createdAt: isValidState(legacy, this.projectRoot)
        ? (legacy.turns[0]?.startedAt ?? now)
        : now,
      updatedAt: isValidState(legacy, this.projectRoot)
        ? (legacy.turns.at(-1)?.completedAt ?? legacy.turns.at(-1)?.startedAt ?? now)
        : now,
      claudeSessionId: this.store.get<string>(LEGACY_CLAUDE_SESSION_KEY),
      codexThreadId: this.store.get<string>(LEGACY_CODEX_THREAD_KEY),
    };
    this.registry = {
      version: 2,
      projectRoot: this.projectRoot,
      activeSessionId: id,
      sessions: [session],
    };
    if (isValidState(legacy, this.projectRoot)) {
      await this.store.update(`${SESSION_STATE_PREFIX}${id}`, legacy);
    }
    await this.persist();
  }

  list(): ProjectSessionSummary[] {
    this.assertReady();
    return [...this.registry!.sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  current(): ProjectSessionSummary {
    this.assertReady();
    const current = this.registry!.sessions.find((session) => session.id === this.registry!.activeSessionId);
    if (!current) throw new Error("The active orchestrator project session is missing.");
    return current;
  }

  async create(): Promise<ProjectSessionSummary> {
    this.assertReady();
    const now = Date.now();
    const session: ProjectSessionSummary = {
      id: randomUUID(),
      title: "New session",
      createdAt: now,
      updatedAt: now,
    };
    this.registry!.sessions.push(session);
    this.registry!.activeSessionId = session.id;
    await this.persist();
    return session;
  }

  async activate(id: string): Promise<ProjectSessionSummary> {
    this.assertReady();
    const session = this.registry!.sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error(`Unknown project session: ${id}`);
    this.registry!.activeSessionId = session.id;
    session.updatedAt = Date.now();
    await this.persist();
    return session;
  }

  async touch(id: string, firstTask?: string): Promise<void> {
    this.assertReady();
    const session = this.registry!.sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    session.updatedAt = Date.now();
    if (session.title === "New session" && firstTask?.trim()) {
      session.title = sessionTitle(firstTask);
    }
    await this.persist();
  }

  async updateNativeSession(
    id: string,
    agent: AgentId,
    nativeSessionId: string | undefined
  ): Promise<void> {
    this.assertReady();
    const session = this.registry!.sessions.find((candidate) => candidate.id === id);
    if (!session) return;
    if (agent === "claude") session.claudeSessionId = nativeSessionId;
    else session.codexThreadId = nativeSessionId;
    session.updatedAt = Date.now();
    await this.persist();
  }

  orchestrationSession(): OrchestrationSession {
    const current = this.current();
    return new OrchestrationSession(this.store, this.projectRoot, current.id);
  }

  private assertReady(): void {
    if (!this.registry) throw new Error("Project session manager has not been initialized.");
  }

  private async persist(): Promise<void> {
    await this.store.update(SESSION_REGISTRY_KEY, this.registry);
  }
}

function sessionTitle(task: string | undefined): string {
  const compact = task?.replace(/\s+/g, " ").trim();
  if (!compact) return "Restored project session";
  return compact.length <= 64 ? compact : `${compact.slice(0, 63)}…`;
}

function isValidState(value: unknown, projectRoot: string): value is OrchestrationState {
  if (!value || typeof value !== "object") return false;
  const state = value as Partial<OrchestrationState>;
  return (
    state.version === 1 &&
    typeof state.id === "string" &&
    state.projectRoot === projectRoot &&
    typeof state.projectSummary === "string" &&
    Array.isArray(state.turns)
  );
}

function isValidRegistry(value: unknown, projectRoot: string): value is ProjectSessionRegistry {
  if (!value || typeof value !== "object") return false;
  const registry = value as Partial<ProjectSessionRegistry>;
  return (
    registry.version === 2 &&
    registry.projectRoot === projectRoot &&
    typeof registry.activeSessionId === "string" &&
    Array.isArray(registry.sessions) &&
    registry.sessions.some((session) => session?.id === registry.activeSessionId)
  );
}

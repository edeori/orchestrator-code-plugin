import type { AgentEvent, ElicitationResponse, PermissionDecision } from "./agentEvent";

export type AgentId = "claude" | "codex";

/** A model the authenticated provider says is available in the current environment. */
export interface AgentModel {
  agent: AgentId;
  id: string;
  displayName: string;
  description: string;
  isDefault: boolean;
  supportedEfforts: string[];
  defaultEffort?: string;
}

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  /** Exact provider model id selected from `availableModels()`. */
  model?: string;
  /** Provider-supported reasoning/effort value selected for this model. */
  effort?: string;
  onEvent: (event: AgentEvent) => void;
}

export interface AgentQuotaFailure {
  kind: "quota";
  message: string;
  /** Epoch milliseconds when the provider says work can resume, if known. */
  retryAt?: number;
}

export interface AgentRunResult {
  exitCode: number;
  /** Present only for a confirmed provider usage/credit limit. */
  failure?: AgentQuotaFailure;
}

export interface Agent {
  id: AgentId;
  /** Runs one turn to completion. Implementations may preserve their native session between calls. */
  run(options: AgentRunOptions): Promise<AgentRunResult>;
  /** Answers a pending `question` event previously emitted with this `id`. No-op if the agent doesn't support interactive questions or the id is unknown/already resolved. */
  answerQuestion(id: string, answers: Record<string, string[]>): void;
  /** Resolves a pending `permission` event previously emitted with this `id`. No-op if unsupported/unknown. */
  resolvePermission(id: string, decision: PermissionDecision): void;
  /** Resolves an MCP server elicitation rendered by the shared host UI. */
  resolveElicitation(id: string, response: ElicitationResponse): void;
  /** Loads or creates the provider session before it is selected for a turn. */
  initialize(cwd: string): Promise<void>;
  /** Returns the authenticated account's currently selectable models. */
  availableModels(cwd: string): Promise<AgentModel[]>;
  /** Interrupts the active turn without discarding the persistent conversation. */
  interrupt(): Promise<void>;
  /**
   * Sends additional user guidance into the currently active native turn.
   * Returns false when no steerable turn exists.
   */
  steer(text: string): Promise<boolean>;
  /** Releases subprocesses, pending interactions and other native session resources. */
  dispose(): Promise<void>;
}

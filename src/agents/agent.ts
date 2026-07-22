import type { AgentEvent, PermissionDecision } from "./agentEvent";

export type AgentId = "claude" | "codex";

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  onEvent: (event: AgentEvent) => void;
}

export interface Agent {
  id: AgentId;
  /** Runs a task to completion, emitting AgentEvents via onEvent. Resolves when the run finishes. */
  run(options: AgentRunOptions): Promise<{ exitCode: number }>;
  /** Answers a pending `question` event previously emitted with this `id`. No-op if the agent doesn't support interactive questions or the id is unknown/already resolved. */
  answerQuestion(id: string, answers: Record<string, string[]>): void;
  /** Resolves a pending `permission` event previously emitted with this `id`. No-op if unsupported/unknown. */
  resolvePermission(id: string, decision: PermissionDecision): void;
}

export type AgentId = "claude" | "codex";

export interface AgentRunOptions {
  prompt: string;
  cwd: string;
  onChunk: (chunk: string) => void;
}

export interface Agent {
  id: AgentId;
  /** Runs a task to completion, streaming raw output via onChunk. Resolves when the process exits. */
  run(options: AgentRunOptions): Promise<{ exitCode: number }>;
}

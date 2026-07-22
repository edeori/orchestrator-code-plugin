import { spawn } from "child_process";
import type { Agent, AgentRunOptions } from "./agent";

/**
 * Delegates a task to the Claude Code CLI in headless/print mode.
 * Requires `claude` to already be installed and authenticated on this machine.
 */
export class ClaudeAgent implements Agent {
  readonly id = "claude" as const;

  constructor(private readonly command: string) {}

  run({ prompt, cwd, onChunk }: AgentRunOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["-p", prompt], {
        cwd,
        shell: false,
      });

      child.stdout.on("data", (data: Buffer) => onChunk(data.toString("utf8")));
      child.stderr.on("data", (data: Buffer) => onChunk(data.toString("utf8")));

      child.on("error", (err) => reject(err));
      child.on("close", (code) => resolve({ exitCode: code ?? 1 }));
    });
  }
}

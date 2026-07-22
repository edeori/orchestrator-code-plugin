import { spawn } from "child_process";
import type { Agent, AgentRunOptions } from "./agent";
import type { PermissionDecision } from "./agentEvent";

/**
 * PLACEHOLDER — intentionally simple. Delegates to the `codex` CLI's
 * `exec` subcommand and streams raw stdout/stderr as plain "text" events;
 * no interactive question/permission dialogs and no live rate-limit
 * gauge, unlike ClaudeAgent.
 *
 * Why not built out yet: Codex's only richer control surface
 * (`codex app-server`) is explicitly marked [experimental] — ~100+
 * undocumented RPC methods with no published wire-protocol spec, would
 * need to be reverse-engineered by hand, and could change without notice
 * on any Codex update. The stable, published `@openai/codex-sdk` package
 * was also checked and does NOT expose an interactive approval/question
 * callback (only a static `approvalPolicy` set once at thread start) or
 * any rate-limit/usage data — so neither the experimental nor the stable
 * path currently gets Codex to parity with ClaudeAgent's interactivity.
 *
 * Left as a deliberate placeholder for whoever picks this up next
 * (possibly using Codex itself to explore the app-server protocol
 * live, which is far more effective than reading generated .d.ts files
 * blind) rather than half-implementing a fragile reverse-engineered
 * client here.
 */
export class CodexAgent implements Agent {
  readonly id = "codex" as const;

  constructor(private readonly command: string) {}

  answerQuestion(_id: string, _answers: Record<string, string[]>): void {
    // No interactive questions from this agent yet — see class docstring.
  }

  resolvePermission(_id: string, _decision: PermissionDecision): void {
    // No interactive permission prompts from this agent yet — see class docstring.
  }

  run({ prompt, cwd, onEvent }: AgentRunOptions): Promise<{ exitCode: number }> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, ["exec", prompt], {
        cwd,
        shell: false,
      });

      child.stdout.on("data", (data: Buffer) => onEvent({ type: "text", text: data.toString("utf8") }));
      child.stderr.on("data", (data: Buffer) => onEvent({ type: "text", text: data.toString("utf8") }));

      child.on("error", (err) => reject(err));
      child.on("close", (code) => {
        const exitCode = code ?? 1;
        onEvent({ type: "done", exitCode });
        resolve({ exitCode });
      });
    });
  }
}

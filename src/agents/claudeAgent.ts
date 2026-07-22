import { randomUUID } from "crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { CanUseTool, PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import type { Agent, AgentRunOptions } from "./agent";
import type { PermissionDecision } from "./agentEvent";

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
  private sessionApprovedTools = new Set<string>();

  answerQuestion(id: string, answers: Record<string, string[]>): void {
    this.pendingQuestions.get(id)?.(answers);
    this.pendingQuestions.delete(id);
  }

  resolvePermission(id: string, decision: PermissionDecision): void {
    this.pendingPermissions.get(id)?.(decision);
    this.pendingPermissions.delete(id);
  }

  async run({ prompt, cwd, onEvent }: AgentRunOptions): Promise<{ exitCode: number }> {
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
        onEvent({ type: "question", id, questions });
        const answersById = await new Promise<Record<string, string[]>>((resolve) => {
          this.pendingQuestions.set(id, resolve);
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
        title: options.title ?? `Claude wants to use ${toolName}`,
        description: options.description ?? JSON.stringify(input),
      });
      const decision = await new Promise<PermissionDecision>((resolve) => {
        this.pendingPermissions.set(id, resolve);
      });

      if (decision === "deny") {
        return { behavior: "deny", message: "Denied by user." };
      }
      if (decision === "allow-session") {
        this.sessionApprovedTools.add(toolName);
      }
      return { behavior: "allow", updatedInput: input };
    };

    let exitCode = 0;
    try {
      const stream = query({
        prompt,
        options: {
          cwd,
          includePartialMessages: true,
          canUseTool,
          // Forced explicitly rather than inherited from whatever the
          // user's own ~/.claude/settings.json happens to say (e.g. a
          // pre-existing "auto" mode + Bash allow-rule, confirmed live on
          // this exact machine to skip canUseTool entirely) — the whole
          // point of building a custom permission UI is for decisions to
          // actually go through it, consistently, regardless of the
          // user's separate interactive-CLI settings.
          permissionMode: "default",
          // Excludes 'user' (and 'local') so a personal global allow-rule
          // like the one just described can't silently bypass our own
          // canUseTool — confirmed live: without this, Bash never
          // triggered a permission event at all on this machine. Keeps
          // 'project' so CLAUDE.md files in the scanned repo still load.
          settingSources: ["project"],
        },
      });
      for await (const message of stream) {
        switch (message.type) {
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
            if (info?.rateLimitType === "five_hour" && typeof info.utilization === "number") {
              onEvent({
                type: "usage",
                rateLimitFiveHour: { utilization: info.utilization, resetsAt: info.resetsAt ?? null },
              });
            }
            break;
          }
          case "result": {
            if ("total_cost_usd" in message) {
              onEvent({ type: "usage", costUsd: message.total_cost_usd });
            }
            if (message.is_error) {
              exitCode = 1;
            }
            break;
          }
          default:
            break;
        }
      }
    } catch (err) {
      onEvent({ type: "error", message: (err as Error).message });
      exitCode = 1;
    }

    onEvent({ type: "done", exitCode });
    return { exitCode };
  }
}

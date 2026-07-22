import type { AgentId } from "../agents/agent";

export interface RoutingDecision {
  agent: AgentId;
  reason: string;
}

const SYSTEM_PROMPT = `You are a routing classifier for a coding assistant orchestrator.
Given a user's task, decide which agent should handle it:

- "claude": multi-file reasoning, architecture/design decisions, refactors, code review, ambiguous or open-ended tasks.
- "codex": narrow, well-specified code generation, single-file edits, quick scripts, boilerplate.

Respond with ONLY a JSON object, no prose, no markdown fences:
{"agent": "claude" | "codex", "reason": "<one short sentence>"}`;

/**
 * Asks a local Ollama model to classify which agent should handle a task.
 * Falls back to "claude" if Ollama is unreachable or returns something unparseable.
 */
export class OllamaRouter {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  async route(task: string): Promise<RoutingDecision> {
    try {
      const response = await fetch(`${this.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: task },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`Ollama responded with HTTP ${response.status}`);
      }

      const data = (await response.json()) as { message?: { content?: string } };
      const content = data.message?.content ?? "";
      return this.parseDecision(content);
    } catch (err) {
      return {
        agent: "claude",
        reason: `Routing fallback (Ollama unavailable: ${(err as Error).message}).`,
      };
    }
  }

  private parseDecision(content: string): RoutingDecision {
    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return { agent: "claude", reason: "Routing fallback (unparseable model response)." };
    }
    try {
      const parsed = JSON.parse(jsonMatch[0]) as { agent?: string; reason?: string };
      const agent: AgentId = parsed.agent === "codex" ? "codex" : "claude";
      return { agent, reason: parsed.reason ?? "No reason given." };
    } catch {
      return { agent: "claude", reason: "Routing fallback (invalid JSON from model)." };
    }
  }
}

/**
 * Normalized events an Agent implementation emits while running a task —
 * agent-agnostic on purpose, so the webview can render Claude's and (once
 * built) Codex's output through the same UI, distinguished only by an
 * `agent` tag the caller attaches, not by different shapes per agent.
 *
 * `question`/`permission` carry no callback function (a function can't
 * survive `postMessage` to the webview) — instead each carries an `id`,
 * and the answer comes back later as a *separate* call the agent's own
 * pending-request map resolves. See ChatViewProvider for the id <-> resolver
 * bookkeeping.
 */
export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "toolUse"; label: string }
  | {
      type: "question";
      id: string;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        multiSelect: boolean;
        options: Array<{ label: string; description: string }>;
      }>;
    }
  | {
      type: "permission";
      id: string;
      title: string;
      description: string;
    }
  | {
      type: "usage";
      costUsd?: number;
      contextPercentage?: number;
      rateLimitFiveHour?: { utilization: number; resetsAt: number | null };
    }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string };

/** What the webview sends back for a pending question. */
export interface QuestionAnswer {
  id: string;
  /** questionId -> chosen option label(s) */
  answers: Record<string, string[]>;
}

export type PermissionDecision = "allow-once" | "allow-session" | "deny";

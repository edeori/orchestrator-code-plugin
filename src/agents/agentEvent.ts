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
  | {
      type: "activity";
      id: string;
      kind: "command" | "fileChange" | "mcp" | "webSearch" | "reasoning" | "other";
      status: "started" | "completed" | "failed";
      label: string;
      detail?: string;
    }
  | {
      type: "question";
      id: string;
      autoResolutionMs?: number | null;
      questions: Array<{
        id: string;
        header: string;
        question: string;
        multiSelect: boolean;
        options?: Array<{ label: string; description: string }>;
        /** Whether a free-form answer is accepted when there are no fixed options. */
        allowFreeText?: boolean;
        /** Whether the UI should provide an additional free-form "Other" choice. */
        isOther?: boolean;
        /** Secret answers must use a password input and must never be echoed. */
        isSecret?: boolean;
      }>;
    }
  | {
      type: "permission";
      id: string;
      kind: "tool" | "command" | "fileChange" | "network" | "filesystem";
      title: string;
      description: string;
      availableDecisions?: PermissionDecision[];
    }
  | {
      type: "elicitation";
      id: string;
      serverName: string;
      mode: "form" | "url";
      message: string;
      title?: string;
      schema?: Record<string, unknown>;
      url?: string;
    }
  | {
      type: "usage";
      costUsd?: number;
      context?: {
        usedTokens: number;
        maxTokens: number;
        percentage: number;
      };
      rateLimits?: Array<{
        id: string;
        label: string;
        usedPercent: number;
        windowDurationMinutes?: number | null;
        /** Unix timestamp in seconds. */
        resetsAt?: number | null;
      }>;
    }
  | { type: "interactionResolved"; id: string; resolution: "answered" | "denied" | "timed-out" | "cancelled" }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string };

/** What the webview sends back for a pending question. */
export interface QuestionAnswer {
  id: string;
  /** questionId -> chosen option label(s) */
  answers: Record<string, string[]>;
}

/**
 * `allow-repo` persists the rule beyond this one session so the same
 * project stops prompting for it entirely — Claude writes it to
 * `.claude/settings.local.json` (the project's personal, gitignored
 * settings file), Codex records it as a trusted project in
 * `~/.codex/config.toml` and remembers it for this workspace so future
 * threads start with a relaxed approval policy. Only offered when the
 * originating agent actually supports that persistence (see each
 * agent's `availableDecisions` construction).
 */
export type PermissionDecision = "allow-once" | "allow-session" | "allow-repo" | "deny";

export interface ElicitationResponse {
  [key: string]: unknown;
  action: "accept" | "decline" | "cancel";
  content?: Record<string, string | number | boolean | string[]>;
}

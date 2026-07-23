import type { AgentId } from "../agents/agent";

export interface RoutingDecision {
  agent: AgentId;
}

const SYSTEM_PROMPT = `Route the current software-development task to exactly one specialist.
- Choose "codex" for concrete implementation, debugging, tests, precise edits, migrations with clear acceptance criteria, and command-heavy repository work.
- Choose "claude" for ambiguous requirements, architecture and tradeoffs, security/design review, cross-cutting analysis, and explanation-first work.
Decide from the task's dominant difficulty. Return only JSON: {"agent":"claude"} or {"agent":"codex"}.`;

const RETRY_SYSTEM_PROMPT =
  'Classify this coding task. Reply with exactly one of these JSON objects and nothing else: {"agent":"codex"} for implementation/debugging, or {"agent":"claude"} for architecture/analysis.';

const MAX_ROUTING_TASK_CHARS = 4_000;
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_RATE_LIMIT_WAIT_MS = 10_000;
const LOCAL_REQUEST_TIMEOUT_MS = 60_000;

export class GroqQuotaError extends Error {
  constructor(message: string, readonly retryAt?: number) {
    super(message);
    this.name = "GroqQuotaError";
  }
}

/** A transient/malformed Groq result that can safely use another router. */
export class GroqRoutingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GroqRoutingError";
  }
}

/** A deliberately tiny Groq classifier: it chooses only Claude vs Codex. */
export class GroqRouter {
  constructor(
    private readonly apiKey: string,
    private readonly model: string
  ) {}

  async route(task: string): Promise<RoutingDecision> {
    const body = {
      model: this.model,
      temperature: 0,
      max_completion_tokens: 32,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: compactTask(task) },
      ],
    };

    let response = await this.requestWithRateLimitRetry(body);
    if (response.status === 429) await throwGroqQuotaError(response);

    if (!response.ok) {
      const firstError = await readGroqApiError(response);
      if (isFailedGeneration(response.status, firstError)) {
        response = await this.requestWithRateLimitRetry({
          model: this.model,
          temperature: 0,
          max_completion_tokens: 24,
          messages: [
            { role: "system", content: RETRY_SYSTEM_PROMPT },
            { role: "user", content: compactTask(task) },
          ],
        });
        if (response.status === 429) await throwGroqQuotaError(response);
        if (!response.ok) {
          const retryError = await readGroqApiError(response);
          if (isFallbackEligibleStatus(response.status) || isFailedGeneration(response.status, retryError)) {
            throw new GroqRoutingError(formatGroqHttpError(response, retryError, " after one JSON retry"));
          }
          throw new Error(formatGroqHttpError(response, retryError, " after one JSON retry"));
        }
      } else if (isFallbackEligibleStatus(response.status)) {
        throw new GroqRoutingError(formatGroqHttpError(response, firstError));
      } else {
        throw new Error(formatGroqHttpError(response, firstError));
      }
    }

    try {
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = data.choices?.[0]?.message?.content ?? "";
      return parseDecision(content, "Groq");
    } catch (error) {
      if (error instanceof GroqRoutingError) throw error;
      throw new GroqRoutingError((error as Error).message);
    }
  }

  private async requestWithRateLimitRetry(body: unknown): Promise<Response> {
    let response: Response;
    try {
      response = await this.request(body);
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
        if (retryAfterMs !== undefined && retryAfterMs <= MAX_RATE_LIMIT_WAIT_MS) {
          await delay(retryAfterMs);
          response = await this.request(body);
        }
      }
      return response;
    } catch (error) {
      throw new GroqRoutingError((error as Error).message);
    }
  }

  private async request(body: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      return await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) throw new Error("Groq routing timed out after 12 seconds.");
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Local fallback used when Groq is quota-limited or cannot produce a routing decision. */
export class OllamaRouter {
  constructor(
    private readonly baseUrl: string,
    private readonly model: string,
    private readonly apiKey?: string,
    private readonly providerName = "Local Ollama"
  ) {}

  async route(task: string): Promise<RoutingDecision> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOCAL_REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.baseUrl.replace(/\/$/, "")}/api/chat`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.model,
          stream: false,
          format: "json",
          think: false,
          options: { temperature: 0, num_predict: 32 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: compactTask(task) },
          ],
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const detail = await readOllamaError(response);
        throw new Error(`${this.providerName} routing failed with HTTP ${response.status}.${detail ? ` ${detail}` : ""}`);
      }
      const data = (await response.json()) as { message?: { content?: string } };
      return parseDecision(data.message?.content ?? "", this.providerName);
    } catch (error) {
      if (controller.signal.aborted) throw new Error(`${this.providerName} routing timed out after 60 seconds.`);
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
}

export class OllamaCloudRouter extends OllamaRouter {
  constructor(apiKey: string, baseUrl: string, model: string) {
    super(baseUrl, model, apiKey, "Ollama Cloud");
  }
}

function parseDecision(content: string, provider: string): RoutingDecision {
  const jsonMatch = content.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`${provider} returned no routing JSON.`);
  try {
    const parsed = JSON.parse(jsonMatch[0]) as { agent?: unknown };
    if (parsed.agent !== "claude" && parsed.agent !== "codex") {
      throw new Error(`${provider} returned an unknown agent.`);
    }
    return { agent: parsed.agent };
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${provider} returned invalid routing JSON.`);
    throw error;
  }
}

function compactTask(task: string): string {
  const trimmed = task.trim();
  if (trimmed.length <= MAX_ROUTING_TASK_CHARS) return trimmed;
  const tailChars = 1_000;
  const headChars = MAX_ROUTING_TASK_CHARS - tailChars;
  return `${trimmed.slice(0, headChars)}\n…[routing input shortened]…\n${trimmed.slice(-tailChars)}`;
}

function parseRetryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now());
  return undefined;
}

function groqRetryAt(response: Response): number | undefined {
  const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
  if (retryAfterMs !== undefined) return Date.now() + retryAfterMs;
  const resetRequestsMs = parseDurationMs(response.headers.get("x-ratelimit-reset-requests"));
  return resetRequestsMs === undefined ? undefined : Date.now() + resetRequestsMs;
}

function parseDurationMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const match = value.trim().match(/^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match) return undefined;
  const days = Number(match[1] ?? 0);
  const hours = Number(match[2] ?? 0);
  const minutes = Number(match[3] ?? 0);
  const seconds = Number(match[4] ?? 0);
  return Math.ceil((days * 86_400 + hours * 3_600 + minutes * 60 + seconds) * 1_000);
}

interface GroqApiError {
  message: string;
  code: string;
  failedGeneration: boolean;
}

async function readGroqApiError(response: Response): Promise<GroqApiError> {
  try {
    const data = (await response.json()) as {
      error?: {
        message?: unknown;
        code?: unknown;
        type?: unknown;
        failed_generation?: unknown;
      };
    };
    const message = typeof data.error?.message === "string" ? data.error.message : "";
    const code = typeof data.error?.code === "string"
      ? data.error.code
      : typeof data.error?.type === "string"
        ? data.error.type
        : "";
    return {
      message,
      code,
      failedGeneration:
        data.error?.failed_generation !== undefined ||
        /failed[_ ]generation|failed to generate json/i.test(`${code} ${message}`),
    };
  } catch {
    return { message: "", code: "", failedGeneration: false };
  }
}

function isFailedGeneration(status: number, error: GroqApiError): boolean {
  return status === 400 && error.failedGeneration;
}

function isFallbackEligibleStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 425 || status >= 500;
}

function formatGroqHttpError(response: Response, error: GroqApiError, suffix = ""): string {
  const retryAfter = response.headers.get("retry-after");
  const retrySuffix = retryAfter ? ` Retry after ${retryAfter}s.` : "";
  const detail = error.message || error.code;
  return `Groq routing failed with HTTP ${response.status}${suffix}.${retrySuffix}${detail ? ` ${detail}` : ""}`;
}

async function throwGroqQuotaError(response: Response): Promise<never> {
  const error = await readGroqApiError(response);
  throw new GroqQuotaError(
    `Groq routing quota is unavailable${error.message ? `: ${error.message}` : "."}`,
    groqRetryAt(response)
  );
}

async function readOllamaError(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as { error?: unknown };
    return typeof data.error === "string" ? data.error : "";
  } catch {
    return "";
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

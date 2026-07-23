import { spawn, type ChildProcessWithoutNullStreams } from "child_process";
import * as fs from "fs";
import * as path from "path";
import * as readline from "readline";

export type RpcId = string | number;

export interface RpcServerMessage {
  id?: RpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export interface CodexAppServerCallbacks {
  onNotification: (method: string, params: unknown) => void;
  onRequest: (id: RpcId, method: string, params: unknown) => void;
  onProtocolError: (error: Error) => void;
  onExit: (error: Error) => void;
}

/**
 * Minimal newline-delimited JSON-RPC transport for `codex app-server`.
 *
 * The public app-server schema is versioned with the CLI. We intentionally
 * keep the transport generic and validate only the fields consumed by the
 * adapter so a new notification does not break the whole connection.
 */
export class CodexAppServerClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private lines: readline.Interface | undefined;
  private nextRequestId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private disposed = false;
  private failed = false;
  private stderrTail: string[] = [];

  constructor(
    private readonly configuredCommand: string,
    private readonly callbacks: CodexAppServerCallbacks
  ) {}

  async start(cwd: string): Promise<void> {
    if (this.child) return;

    const launch = this.resolveLaunch();
    const child = spawn(launch.command, [...launch.args, "app-server"], {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stderr.on("data", (chunk: Buffer) => {
      const lines = chunk
        .toString("utf8")
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
      this.stderrTail.push(...lines);
      this.stderrTail = this.stderrTail.slice(-20);
    });

    this.lines = readline.createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));

    child.on("error", (error) => this.failAll(error));
    child.on("close", (code, signal) => {
      if (this.disposed) return;
      const detail = signal ? `signal ${signal}` : `code ${code ?? 1}`;
      const stderr = this.stderrTail.length ? `\n${this.stderrTail.join("\n")}` : "";
      this.failAll(new Error(`Codex app-server exited with ${detail}.${stderr}`));
    });

    await this.request("initialize", {
      clientInfo: {
        name: "orchestrator_code",
        title: "Orchestrator Code",
        version: "0.1.0",
      },
      capabilities: {
        experimentalApi: true,
        mcpServerOpenaiFormElicitation: true,
        requestAttestation: false,
      },
    });
    this.notify("initialized", {});
  }

  request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    const id = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      try {
        this.write({ method, id, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params: unknown): void {
    this.write({ method, params });
  }

  respond(id: RpcId, result: unknown): void {
    this.write({ id, result });
  }

  respondError(id: RpcId, code: number, message: string): void {
    this.write({ id, error: { code, message } });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error("Codex app-server connection closed.");
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.lines?.close();
    this.child?.stdin.end();
    if (this.child && !this.child.killed) this.child.kill();
    this.child = undefined;
  }

  private resolveLaunch(): { command: string; args: string[] } {
    if (this.configuredCommand !== "codex") {
      return { command: this.configuredCommand, args: [] };
    }

    try {
      // Pin the protocol and runtime together by preferring the CLI bundled
      // with @openai/codex-sdk over an independently updated global binary.
      // Resolve the native executable directly: process.execPath is Electron
      // inside VS Code and is not a safe substitute for the Node executable.
      const platform = bundledPlatform();
      if (!platform) throw new Error(`Unsupported platform: ${process.platform}/${process.arch}`);
      const packageJson = require.resolve(`${platform.packageName}/package.json`);
      const binary = path.join(
        path.dirname(packageJson),
        "vendor",
        platform.targetTriple,
        "bin",
        process.platform === "win32" ? "codex.exe" : "codex"
      );
      if (!fs.statSync(binary).isFile()) throw new Error("Bundled Codex executable is missing.");
      return { command: binary, args: [] };
    } catch {
      return { command: this.configuredCommand, args: [] };
    }
  }

  private write(message: RpcServerMessage): void {
    if (!this.child || this.disposed || !this.child.stdin.writable) {
      throw new Error("Codex app-server is not running.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private handleLine(line: string): void {
    let message: RpcServerMessage;
    try {
      message = JSON.parse(line) as RpcServerMessage;
    } catch {
      this.callbacks.onProtocolError(new Error(`Invalid JSON from Codex app-server: ${line.slice(0, 300)}`));
      return;
    }

    if (message.method && message.id !== undefined) {
      this.callbacks.onRequest(message.id, message.method, message.params);
      return;
    }
    if (message.method) {
      this.callbacks.onNotification(message.method, message.params);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(message.error.message ?? `Codex app-server error ${message.error.code ?? "unknown"}`));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  private failAll(error: Error): void {
    if (this.failed || this.disposed) return;
    this.failed = true;
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    this.pending.clear();
    this.callbacks.onExit(error);
  }
}

function bundledPlatform(): { packageName: string; targetTriple: string } | undefined {
  const key = `${process.platform}-${process.arch}`;
  return {
    "darwin-arm64": { packageName: "@openai/codex-darwin-arm64", targetTriple: "aarch64-apple-darwin" },
    "darwin-x64": { packageName: "@openai/codex-darwin-x64", targetTriple: "x86_64-apple-darwin" },
    "linux-arm64": { packageName: "@openai/codex-linux-arm64", targetTriple: "aarch64-unknown-linux-musl" },
    "linux-x64": { packageName: "@openai/codex-linux-x64", targetTriple: "x86_64-unknown-linux-musl" },
    "win32-arm64": { packageName: "@openai/codex-win32-arm64", targetTriple: "aarch64-pc-windows-msvc" },
    "win32-x64": { packageName: "@openai/codex-win32-x64", targetTriple: "x86_64-pc-windows-msvc" },
  }[key];
}

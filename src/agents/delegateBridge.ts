import * as crypto from "crypto";
import * as net from "net";
import * as os from "os";
import * as path from "path";

export interface DelegateResult {
  text: string;
  exitCode: number;
}

export type DelegateHandler = (task: string) => Promise<DelegateResult>;

/**
 * Local IPC endpoint that lets a Codex thread hand a subtask to Claude even
 * though the bundled Codex app-server protocol (0.145.0) has no in-process
 * "dynamic tool" registration — unlike the Claude Agent SDK's `createSdkMcpServer`,
 * which the Claude side uses directly, in-process, for the reverse direction
 * (see claudeAgent.ts). So this side is a tiny external MCP server instead:
 * `delegateBridgeServer.ts` is registered as a `command`/`args` MCP server in
 * `~/.codex/config.toml` (see CodexAgent.registerDelegateBridge), Codex spawns
 * it like any other configured MCP server, and *that* process talks back to
 * this long-lived extension host over the socket this class listens on —
 * never over the network, one connection per delegated call.
 */
export class DelegateBridge {
  private server: net.Server | undefined;
  private socketPath: string | undefined;
  private listening: Promise<string> | undefined;

  constructor(private readonly handler: DelegateHandler) {}

  /** Absolute path to the compiled bridge script `node` should run. */
  static readonly scriptPath = path.join(__dirname, "delegateBridgeServer.js");

  async ensureListening(): Promise<string> {
    if (this.listening) return this.listening;
    this.listening = this.start().catch((error) => {
      this.listening = undefined;
      throw error;
    });
    return this.listening;
  }

  private async start(): Promise<string> {
    const socketPath = allocateSocketPath();
    const server = net.createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const newline = buffer.indexOf("\n");
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = "";
        void this.handleRequest(line, socket);
      });
      socket.on("error", () => {
        // The bridge subprocess disconnecting mid-call is not this
        // extension's problem to recover from; the pending delegated turn
        // (if any) still runs to completion, its result just goes unread.
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    this.server = server;
    this.socketPath = socketPath;
    return socketPath;
  }

  private async handleRequest(line: string, socket: net.Socket): Promise<void> {
    let response: { ok: true; text: string; exitCode: number } | { ok: false; error: string };
    try {
      const request = JSON.parse(line) as { task?: unknown };
      if (typeof request.task !== "string" || !request.task.trim()) {
        throw new Error("Missing 'task' string in delegate request.");
      }
      const result = await this.handler(request.task);
      response = { ok: true, text: result.text, exitCode: result.exitCode };
    } catch (error) {
      response = { ok: false, error: (error as Error).message };
    }
    try {
      socket.end(`${JSON.stringify(response)}\n`);
    } catch {
      // Socket already gone — nothing left to do.
    }
  }

  dispose(): void {
    this.server?.close();
    this.server = undefined;
    this.listening = undefined;
    if (this.socketPath && process.platform !== "win32") {
      try {
        require("fs").unlinkSync(this.socketPath);
      } catch {
        // Best-effort cleanup only.
      }
    }
    this.socketPath = undefined;
  }
}

function allocateSocketPath(): string {
  const id = crypto.randomBytes(8).toString("hex");
  if (process.platform === "win32") {
    return `\\\\.\\pipe\\orchestrator-code-delegate-${id}`;
  }
  return path.join(os.tmpdir(), `orchestrator-code-delegate-${id}.sock`);
}

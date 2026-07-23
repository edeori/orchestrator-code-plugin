#!/usr/bin/env node
/**
 * Standalone process — NOT part of the extension host. Codex's app-server
 * spawns this directly (as a `command`/`args` entry under `mcp_servers` in
 * `~/.codex/config.toml`, registered by CodexAgent.registerDelegateBridge)
 * exactly like any other MCP server it's configured to talk to. It exposes
 * one tool, `delegate_to_claude`, and forwards each call over a local socket
 * to the long-lived VS Code extension host, which actually runs a Claude
 * turn and sends the result back. See delegateBridge.ts for the other end.
 *
 * Deliberately has zero dependency on the `vscode` module — this file is
 * `node <path>`'d by Codex, outside VS Code's process tree.
 */
import * as net from "net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const socketPath = process.env.ORCHESTRATOR_DELEGATE_SOCKET;

async function requestDelegate(task: string): Promise<{ ok: true; text: string; exitCode: number } | { ok: false; error: string }> {
  if (!socketPath) {
    return { ok: false, error: "ORCHESTRATOR_DELEGATE_SOCKET is not set — the orchestrator extension didn't configure this bridge." };
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(socketPath);
    let buffer = "";
    let settled = false;
    const finish = (result: { ok: true; text: string; exitCode: number } | { ok: false; error: string }) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.on("connect", () => {
      socket.end(`${JSON.stringify({ task })}\n`);
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
    });
    socket.on("close", () => {
      if (settled) return;
      const line = buffer.split("\n")[0];
      if (!line) {
        finish({ ok: false, error: "The orchestrator extension closed the connection without a response (is the VS Code window still open?)." });
        return;
      }
      try {
        const parsed = JSON.parse(line);
        finish(parsed);
      } catch {
        finish({ ok: false, error: `Malformed response from the orchestrator extension: ${line.slice(0, 200)}` });
      }
    });
    socket.on("error", (error) => {
      finish({ ok: false, error: `Could not reach the orchestrator extension: ${(error as Error).message}` });
    });
  });
}

async function main(): Promise<void> {
  const server = new McpServer({ name: "orchestrator-code-delegate", version: "1.0.0" });

  server.registerTool(
    "delegate_to_claude",
    {
      title: "Delegate to Claude",
      description:
        "Hands a subtask to a fresh Claude Code turn in this same project and returns its final answer as text. " +
        "Use this for anything Claude is specifically better positioned for in this workspace — for example " +
        "controlling the local machine (taking a screenshot, opening an application, running a project scan) — " +
        "or simply to get a second model's take on part of the task. The delegated turn runs independently: it " +
        "does not see this conversation's history, so include everything it needs to know in the task text.",
      inputSchema: { task: z.string().min(1).describe("Full, self-contained description of the subtask for Claude to carry out.") },
    },
    async ({ task }) => {
      const result = await requestDelegate(task);
      if (!result.ok) {
        return { content: [{ type: "text", text: `Delegation to Claude failed: ${result.error}` }], isError: true };
      }
      const suffix = result.exitCode !== 0 ? "\n\n[Claude's delegated turn ended with an error.]" : "";
      return { content: [{ type: "text", text: `${result.text}${suffix}` }] };
    }
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("orchestrator delegate bridge failed to start:", error);
  process.exit(1);
});

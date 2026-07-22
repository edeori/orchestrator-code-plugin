import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readGlobalClaudeMcpServers } from "./syncMcpConfig";

export interface ScanProjectResult {
  project: string;
  language: string;
  scanned_files: number;
  skipped_files: string[];
  types_imported: number;
  error?: string;
}

/**
 * Spawns the code-graph MCP server directly (same stdio subprocess model
 * Claude/Codex use) just for the duration of one `scan_project` call, then
 * disconnects — this extension doesn't need a long-lived MCP connection,
 * only an on-demand way to trigger a scan from the "Scan" button. Reuses
 * readGlobalClaudeMcpServers rather than hardcoding the server's
 * command/args/env, so it stays in sync with however code-graph is actually
 * configured on this machine (including its Neo4j host/password env vars).
 */
export async function scanProject(path: string, project: string, language: string): Promise<ScanProjectResult> {
  const servers = readGlobalClaudeMcpServers(["code-graph"]);
  const server = servers["code-graph"];
  if (!server) {
    throw new Error(
      "nincs 'code-graph' MCP szerver regisztrálva a ~/.claude.json-ban — állítsd be előbb (lásd code-graph-mcp README)."
    );
  }

  const transport = new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...process.env, ...(server.env ?? {}) } as Record<string, string>,
  });

  const client = new Client({ name: "orchestrator-code", version: "0.1.0" });
  await client.connect(transport);

  try {
    const result = await client.callTool({
      name: "scan_project",
      arguments: { path, project, language },
    });
    const content = result.content as Array<{ type: string; text?: string }> | undefined;
    const text = content?.find((c) => c.type === "text")?.text;
    if (!text) {
      throw new Error("a scan_project hívás nem adott vissza szöveges eredményt");
    }
    return JSON.parse(text) as ScanProjectResult;
  } finally {
    await client.close();
  }
}

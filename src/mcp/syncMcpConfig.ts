import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface StdioMcpServerConfig {
  type?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * Reads named MCP server definitions from the user's global Claude Code config
 * (~/.claude.json) so the same servers can be mirrored into a workspace for
 * both Claude and Codex. Secrets (env vars, tokens embedded in args) travel
 * only through local, gitignored files — never through anything this
 * extension writes into version control or logs.
 */
function readGlobalClaudeMcpServers(names: string[]): Record<string, StdioMcpServerConfig> {
  const claudeConfigPath = path.join(os.homedir(), ".claude.json");
  if (!fs.existsSync(claudeConfigPath)) {
    return {};
  }

  const raw = JSON.parse(fs.readFileSync(claudeConfigPath, "utf8"));
  const allServers: Record<string, StdioMcpServerConfig> = raw.mcpServers ?? raw;

  const result: Record<string, StdioMcpServerConfig> = {};
  for (const name of names) {
    if (allServers[name]) {
      result[name] = allServers[name];
    }
  }
  return result;
}

/** Writes/merges the given servers into the workspace's project-level .mcp.json for Claude Code. */
function syncClaudeProjectConfig(workspaceRoot: string, servers: Record<string, StdioMcpServerConfig>): void {
  const mcpJsonPath = path.join(workspaceRoot, ".mcp.json");
  const existing = fs.existsSync(mcpJsonPath)
    ? JSON.parse(fs.readFileSync(mcpJsonPath, "utf8"))
    : { mcpServers: {} };

  existing.mcpServers = { ...existing.mcpServers, ...servers };
  fs.writeFileSync(mcpJsonPath, JSON.stringify(existing, null, 2) + "\n", "utf8");
}

/** Serializes one server entry as a `[mcp_servers.<name>]` TOML table. */
function toTomlBlock(name: string, config: StdioMcpServerConfig): string {
  const lines = [`[mcp_servers.${name}]`, `command = ${JSON.stringify(config.command)}`];
  if (config.args?.length) {
    lines.push(`args = [${config.args.map((a) => JSON.stringify(a)).join(", ")}]`);
  }
  if (config.env && Object.keys(config.env).length > 0) {
    const envEntries = Object.entries(config.env)
      .map(([k, v]) => `${JSON.stringify(k)} = ${JSON.stringify(v)}`)
      .join(", ");
    lines.push(`env = { ${envEntries} }`);
  }
  return lines.join("\n");
}

/**
 * Merges the given servers into ~/.codex/config.toml. This performs a simple
 * text-level replace of any existing `[mcp_servers.<name>]` block rather than
 * a full TOML parse, which is sufficient for managing servers this extension
 * itself owns without disturbing the rest of the user's Codex config.
 */
function syncCodexConfig(servers: Record<string, StdioMcpServerConfig>): void {
  const codexDir = path.join(os.homedir(), ".codex");
  const configPath = path.join(codexDir, "config.toml");
  fs.mkdirSync(codexDir, { recursive: true });

  let content = fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : "";

  for (const [name, config] of Object.entries(servers)) {
    const headerPattern = new RegExp(`\\[mcp_servers\\.${name}\\][\\s\\S]*?(?=\\n\\[|$)`, "g");
    content = content.replace(headerPattern, "").trimEnd();
    content += (content.length > 0 ? "\n\n" : "") + toTomlBlock(name, config) + "\n";
  }

  fs.writeFileSync(configPath, content, "utf8");
}

export function syncMcpServers(workspaceRoot: string, serverNames: string[]): { synced: string[]; missing: string[] } {
  const servers = readGlobalClaudeMcpServers(serverNames);
  const synced = Object.keys(servers);
  const missing = serverNames.filter((n) => !synced.includes(n));

  if (synced.length > 0) {
    syncClaudeProjectConfig(workspaceRoot, servers);
    syncCodexConfig(servers);
  }

  return { synced, missing };
}

import * as vscode from "vscode";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { syncMcpServers } from "./mcp/syncMcpConfig";

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orchestratorCode.focusChat", async () => {
      await vscode.commands.executeCommand("orchestratorCode.chatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orchestratorCode.syncMcpServers", async () => {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!workspaceRoot) {
        vscode.window.showWarningMessage("Orchestrator: open a workspace folder before syncing MCP servers.");
        return;
      }

      const serverNames = vscode.workspace
        .getConfiguration("orchestratorCode")
        .get<string[]>("mcpServers", []);

      const { synced, missing } = syncMcpServers(workspaceRoot, serverNames);

      if (synced.length > 0) {
        vscode.window.showInformationMessage(
          `Orchestrator: synced MCP server(s) [${synced.join(", ")}] to Claude (.mcp.json) and Codex (~/.codex/config.toml).`
        );
      }
      if (missing.length > 0) {
        vscode.window.showWarningMessage(
          `Orchestrator: MCP server(s) [${missing.join(", ")}] were not found in ~/.claude.json — configure them there first.`
        );
      }
    })
  );
}

export function deactivate(): void {}

import * as path from "path";
import * as vscode from "vscode";
import { ChatViewProvider } from "./webview/ChatViewProvider";
import { syncMcpServers } from "./mcp/syncMcpConfig";
import { scanProject } from "./mcp/codeGraphClient";
import { inspectProjectLanguages } from "./scan/detectLanguage";

const _LANGUAGE_OPTIONS: Array<{ label: string; value: string; description: string }> = [
  { label: "Python", value: "python", description: "standard-library AST — modules, classes, functions and imports" },
  { label: "Java", value: "java", description: "tree-sitter, fast, zero extra deps" },
  { label: "Java (JavaParser)", value: "java-javaparser", description: "more precise — nested types, resolved signatures; needs a JDK + built jar" },
  { label: "JavaScript / TypeScript", value: "javascript", description: "tree-sitter, React/Angular-aware" },
  { label: "C++", value: "cpp", description: "tree-sitter, fast, zero extra deps" },
  { label: "C++ (libclang)", value: "cpp-clang", description: "more precise — macros, templates, nested types; needs libclang" },
];

export function activate(context: vscode.ExtensionContext): void {
  const provider = new ChatViewProvider(context.extensionUri, context.workspaceState, context.secrets);
  context.subscriptions.push(provider);
  if (vscode.workspace.workspaceFolders?.length) {
    void provider.initializeSessions().catch((error) => {
      vscode.window.showWarningMessage(`Orchestrator session restore failed: ${(error as Error).message}`);
    });
  }
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, provider, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orchestratorCode.focusChat", async () => {
      await vscode.commands.executeCommand("orchestratorCode.chatView.focus");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orchestratorCode.setGroqApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Groq API key (free — get one at console.groq.com), used only for routing decisions",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      await context.secrets.store(ChatViewProvider.groqApiKeySecret, key);
      vscode.window.showInformationMessage("Orchestrator: Groq API key saved.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("orchestratorCode.setOllamaCloudApiKey", async () => {
      const key = await vscode.window.showInputBox({
        prompt: "Ollama Cloud API key, used only if both Groq routing and local Ollama are unavailable",
        password: true,
        ignoreFocusOut: true,
      });
      if (!key) return;
      await context.secrets.store(ChatViewProvider.ollamaCloudApiKeySecret, key);
      vscode.window.showInformationMessage("Orchestrator: Ollama Cloud API key saved.");
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

  context.subscriptions.push(
    vscode.commands.registerCommand("orchestratorCode.scanProject", async () => {
      const workspaceFolder = await selectWorkspaceFolderForScan();
      if (!workspaceFolder) {
        if (!vscode.workspace.workspaceFolders?.length) {
          vscode.window.showWarningMessage("Orchestrator: open a workspace folder before scanning.");
        }
        return;
      }
      const workspaceRoot = workspaceFolder.uri.fsPath;

      const inspection = inspectProjectLanguages(workspaceRoot);
      const likely = inspection.likely;
      const ordered = likely
        ? [..._LANGUAGE_OPTIONS.filter((o) => o.value === likely), ..._LANGUAGE_OPTIONS.filter((o) => o.value !== likely)]
        : _LANGUAGE_OPTIONS;

      const picked = await vscode.window.showQuickPick(
        ordered.map((o) => ({ label: o.label, description: o.description, value: o.value })),
        { placeHolder: likely ? `Language to scan (detected: ${likely})` : "Language to scan" }
      );
      if (!picked) {
        return;
      }

      const sourceLanguage =
        picked.value === "java-javaparser"
          ? "java"
          : picked.value === "cpp-clang"
            ? "cpp"
            : picked.value;
      if (!inspection.truncated && (inspection.counts[sourceLanguage] ?? 0) === 0) {
        const message =
          `Scan not started: no ${picked.label} source files were found under ${workspaceRoot}.`;
        vscode.window.showWarningMessage(`Orchestrator: ${message}`);
        provider.logScanMessage(`[scan:${path.basename(workspaceRoot)}] ${message}`);
        return;
      }

      const defaultProject = path.basename(workspaceRoot);
      const project = await vscode.window.showInputBox({
        prompt: "Project tag — separates this codebase from others in the same shared code graph",
        value: defaultProject,
      });
      if (!project) {
        return;
      }

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Orchestrator: scanning ${project} (${picked.value})...` },
        async () => {
          try {
            const result = await scanProject(workspaceRoot, project, picked.value);
            if (result.error) {
              vscode.window.showErrorMessage(`Orchestrator scan failed: ${result.error}`);
              provider.logScanMessage(`[scan:${project}] error: ${result.error}`);
              return;
            }
            const summary = `[scan:${project}] ${result.language}: ${result.scanned_files} files scanned, ${result.types_imported} types imported into the shared code graph.`;
            vscode.window.showInformationMessage(summary);
            provider.logScanMessage(summary);
            if (result.skipped_files.length > 0) {
              provider.logScanMessage(`[scan:${project}] skipped: ${result.skipped_files.join(", ")}`);
            }
          } catch (err) {
            const message = (err as Error).message;
            vscode.window.showErrorMessage(`Orchestrator scan failed: ${message}`);
            provider.logScanMessage(`[scan:${project}] error: ${message}`);
          }
        }
      );
    })
  );
}

async function selectWorkspaceFolderForScan(): Promise<vscode.WorkspaceFolder | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length <= 1) return folders[0];

  const selected = await vscode.window.showQuickPick(
    folders.map((folder) => ({
      label: `$(repo) ${folder.name}`,
      description: folder.uri.fsPath,
      folder,
    })),
    {
      title: "Select project to scan",
      placeHolder: "Only the selected workspace folder will be scanned",
      matchOnDescription: true,
    }
  );
  return selected?.folder;
}

export function deactivate(): void {}

import * as vscode from "vscode";
import { OllamaRouter } from "../orchestrator/router";
import { ClaudeAgent } from "../agents/claudeAgent";
import { CodexAgent } from "../agents/codexAgent";
import type { Agent } from "../agents/agent";

type WebviewInMessage = { type: "userMessage"; text: string };
type WebviewOutMessage =
  | { type: "routing"; agent: string; reason: string }
  | { type: "chunk"; text: string }
  | { type: "done"; exitCode: number }
  | { type: "error"; message: string }
  | { type: "scan"; text: string };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "orchestratorCode.chatView";

  private webview: vscode.Webview | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    this.webview = webviewView.webview;

    webviewView.webview.onDidReceiveMessage(async (message: WebviewInMessage) => {
      if (message.type === "userMessage") {
        await this.handleUserMessage(message.text, webviewView.webview);
      }
    });
  }

  /** Lets other commands (e.g. "Scan Project") log into the same chat
   * panel instead of only showing a transient notification — the panel
   * doubles as the extension's one activity log. A no-op if the panel
   * hasn't been opened/resolved yet in this window. */
  logScanMessage(text: string): void {
    this.webview?.postMessage({ type: "scan", text } satisfies WebviewOutMessage);
  }

  private async handleUserMessage(text: string, webview: vscode.Webview): Promise<void> {
    const post = (msg: WebviewOutMessage) => webview.postMessage(msg);
    const config = vscode.workspace.getConfiguration("orchestratorCode");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    try {
      const router = new OllamaRouter(
        config.get<string>("ollamaBaseUrl", "http://localhost:11434"),
        config.get<string>("ollamaModel", "qwen2.5-coder:7b")
      );
      const decision = await router.route(text);
      post({ type: "routing", agent: decision.agent, reason: decision.reason });

      const agent: Agent =
        decision.agent === "codex"
          ? new CodexAgent(config.get<string>("codexCommand", "codex"))
          : new ClaudeAgent(config.get<string>("claudeCommand", "claude"));

      const { exitCode } = await agent.run({
        prompt: text,
        cwd: workspaceRoot,
        onChunk: (chunk) => post({ type: "chunk", text: chunk }),
      });
      post({ type: "done", exitCode });
    } catch (err) {
      post({ type: "error", message: (err as Error).message });
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.css"));
    const nonce = String(Date.now());

    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';" />
  <link href="${styleUri}" rel="stylesheet" />
  <title>Orchestrator Chat</title>
</head>
<body>
  <div id="log"></div>
  <form id="composer">
    <textarea id="input" placeholder="Describe the task..." rows="3"></textarea>
    <button type="submit">Send</button>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

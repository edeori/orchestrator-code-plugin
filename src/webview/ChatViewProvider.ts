import * as vscode from "vscode";
import { OllamaRouter } from "../orchestrator/router";
import { ClaudeAgent } from "../agents/claudeAgent";
import { CodexAgent } from "../agents/codexAgent";
import type { Agent, AgentId } from "../agents/agent";
import type { AgentEvent, PermissionDecision } from "../agents/agentEvent";

type WebviewInMessage =
  | { type: "userMessage"; text: string }
  | { type: "answerQuestion"; id: string; answers: Record<string, string[]> }
  | { type: "resolvePermission"; id: string; decision: PermissionDecision };

type WebviewOutMessage = ({ agent?: AgentId } & AgentEvent) | { type: "routing"; agent: string; reason: string } | { type: "scan"; text: string };

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = "orchestratorCode.chatView";

  private webview: vscode.Webview | undefined;
  /** The agent instance currently handling a run, so a later
   * answerQuestion/resolvePermission message from the webview can be
   * routed to the right pending request. Only one run happens at a time
   * in this v1 (no queuing/concurrency), so a single field is enough. */
  private currentAgent: Agent | undefined;

  constructor(private readonly extensionUri: vscode.Uri) {}

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = { enableScripts: true };
    webviewView.webview.html = this.renderHtml(webviewView.webview);
    this.webview = webviewView.webview;

    webviewView.webview.onDidReceiveMessage(async (message: WebviewInMessage) => {
      if (message.type === "userMessage") {
        await this.handleUserMessage(message.text, webviewView.webview);
      } else if (message.type === "answerQuestion") {
        this.currentAgent?.answerQuestion(message.id, message.answers);
      } else if (message.type === "resolvePermission") {
        this.currentAgent?.resolvePermission(message.id, message.decision);
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
    const config = vscode.workspace.getConfiguration("orchestratorCode");
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    try {
      const router = new OllamaRouter(
        config.get<string>("ollamaBaseUrl", "http://localhost:11434"),
        config.get<string>("ollamaModel", "qwen2.5-coder:7b")
      );
      const decision = await router.route(text);
      webview.postMessage({ type: "routing", agent: decision.agent, reason: decision.reason } satisfies WebviewOutMessage);

      const agent: Agent =
        decision.agent === "codex"
          ? new CodexAgent(config.get<string>("codexCommand", "codex"))
          : new ClaudeAgent();
      this.currentAgent = agent;

      const post = (event: AgentEvent) => webview.postMessage({ ...event, agent: agent.id } satisfies WebviewOutMessage);

      await agent.run({ prompt: text, cwd: workspaceRoot, onEvent: post });
      this.currentAgent = undefined;
    } catch (err) {
      webview.postMessage({ type: "error", message: (err as Error).message } satisfies WebviewOutMessage);
      this.currentAgent = undefined;
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
  <div id="usage-bar" class="usage-bar" hidden>
    <div id="usage-fill" class="usage-fill"></div>
    <span id="usage-label" class="usage-label"></span>
  </div>
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

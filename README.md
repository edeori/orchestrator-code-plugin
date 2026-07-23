# Orchestrator Code

A VS Code extension that adds an activity-bar chat panel backed by a **task
router**. You describe a task; a fast Groq-hosted model classifies it
and delegates the actual work to either Claude Code or Codex, streaming
their output back into the chat — the same panel doubles as a real,
interactive chat UI: it can pop up the same clarifying-question and
permission dialogs you'd get from either tool's own CLI, live, right in the
panel.

Both agents can be given access to the same MCP servers (e.g. `code-graph`)
so they share one view of the codebase regardless of which one handles a
given task. A "Scan" button on the chat panel also lets you trigger a
`code-graph` scan of the current workspace directly, without going through
either agent.

The extension keeps one durable orchestration session per VS Code workspace.
That project session links the host's compact project memory with one
native Claude session and one native Codex thread. On VS Code startup the
extension eagerly validates/rejoins both native sessions, so a later task is
another turn in the same development project rather than a fresh standalone
prompt. The project history is handed only to the selected coding agent; Groq
receives just the current task and decides only Claude versus Codex.

Routing fallback is automatic. If Groq reports `failed_generation`, one
simplified Groq retry is attempted without structured-output enforcement.
Repeated malformed output, transient/server errors and quota responses send
the same minimal classification to local Ollama; quota cooldowns are
remembered. If local Ollama cannot route the task, Ollama Cloud is the final
routing fallback. Authentication and invalid-model errors remain visible
instead of being hidden behind fallback. If the selected coding provider reports a
confirmed usage/credit limit, the original task is retried once with the
other provider using the closest available model class (fast, balanced or
powerful). Provider cooldowns are stored in workspace state, preventing every
new task from first consuming a known-to-fail request.

At startup Claude's SDK control channel and Codex App Server report the models
actually available to the authenticated accounts. After Groq chooses the
provider, the host uses that provider's default allowed model. The model
catalog, effort options and project history are never included in the Groq
request. The chosen provider/model is shown in the chat and stored with the
orchestrator turn.

## Status

- **Claude** — drives a resumable Claude Agent SDK session (`agents/claudeAgent.ts`),
  not a subprocess text-pipe. This is what makes the interactive
  question/permission dialogs and the live rate-limit gauge possible at all:
  - `AskUserQuestion` tool calls render as a real multi-choice dialog in the
    panel; your answer resumes the same turn, and later chat messages resume
    the same native Claude conversation.
  - Every other tool needing approval (Bash, Write, Edit, ...) renders as an
    Allow once / Allow for session / Deny dialog, using the SDK's own
    pre-rendered prompt text (`"Claude wants to use Write"`, etc.).
  - The usage panel tracks the 5-hour rate-limit window
    (`rate_limit_event` messages) and shows session cost (`total_cost_usd`)
    when available; API-key sessions can expose cost without a plan limit.
  - All of the above verified live against a real session, not just typed
    against the SDK's declarations — see `agents/claudeAgent.ts`'s own
    comments for the two real gotchas that cost the most time: a
    pre-existing `~/.claude/settings.json` allow-rule can silently bypass
    `canUseTool` entirely unless `settingSources` excludes `'user'`, and
    `AskUserQuestion`'s resume payload is keyed by the **question's full
    text**, not an id/header, with multi-select answers comma-joined —
    both undocumented in the type declarations alone.
  - Available Claude models are discovered through
    the SDK control channel without submitting a model prompt or creating a
    throwaway persisted session. The account default allowed model is applied
    when the real resumed turn begins.
- **Codex** — uses one persistent `codex app-server` process and native thread
  (`agents/codexAgent.ts`) instead of `codex exec`. Agent-message deltas,
  command/file/permission approvals, `request_user_input`, item lifecycle,
  context-window usage and account rate-limit windows are translated into
  the same UI events as Claude. The default command resolves the native CLI
  bundled with `@openai/codex-sdk`, keeping the protocol and runtime version
  pinned together; a custom CLI can still be selected in settings.
  `model/list` supplies the account-visible models and default; `turn/start`
  applies that allowed default without
  forking or replacing the persistent thread.
- The shared question UI supports fixed choices, free-text and secret input,
  Codex's optional `Other` field, and timed auto-resolution. Usage is shown
  in separate per-agent context and rate-limit meters rather than one
  overloaded bar. Active turns can be stopped from the composer.
- In the composer, `Enter` sends and `Shift+Enter` inserts a newline. While
  an agent is running, **Send now** uses Claude streaming input or Codex
  `turn/steer` to inject guidance into the active native turn; **Queue** keeps
  a FIFO list of follow-up tasks and runs each automatically after the current
  turn finishes.
- The project-session picker groups the local orchestration history, one
  Claude session and one Codex thread into a single selectable entry. New
  sessions can be created from the toolbar; switching entries resumes both
  native conversations together. The pre-picker single-session state is
  migrated automatically on first start.
  Session metadata is stored in VS Code `workspaceState`. The extension
  activates after VS Code startup and eagerly validates the selected Claude
  SDK session and rejoins the selected Codex thread before a new prompt is
  submitted.
  Confirmed-missing sessions are replaced safely; transient resume errors do
  not erase the stored identifier. The visual transcript and unfinished
  composer draft are kept when the view is hidden and restored if VS Code
  recreates the webview. Pending interactive controls stay live while merely
  switching views, but are deliberately not serialized across a full reload.
- MCP servers can request structured input through the same chat. Standard
  form elicitation renders typed fields (including choices, booleans and
  multi-select values); URL elicitation offers a safe browser-open action and
  returns accept/decline/cancel to the requesting Claude or Codex MCP client.
- MCP-server mirroring and the code-graph scan button work end-to-end for
  both agents already.

## Architecture

```
media/                  webview client (chat UI: HTML/CSS/JS)
src/extension.ts         activation, commands
src/webview/             WebviewViewProvider for the chat panel — owns
                         routing question/permission answers back to
                         whichever agent is currently running
src/orchestrator/        Groq-based task router (claude vs codex) and the
                         durable workspace-level project session
src/agents/              agent.ts (shared interface), agentEvent.ts (the
                         normalized event model both agents emit),
                         claudeAgent.ts (Claude Agent SDK), codexAgent.ts
                         + codexAppServer.ts (persistent App Server JSON-RPC)
src/mcp/                 mirrors MCP server definitions to both CLIs; also a
                         direct MCP client used by the "Scan" button
src/scan/                best-effort language auto-detection for the picker
```

Flow: user message in webview -> `GroqRouter.route()` receives only that
message and chooses Claude or Codex (local `OllamaRouter`, then Ollama Cloud,
take over for Groq quota, transient or malformed-generation failures) -> the project session adds prior outcomes
and its durable summary to the selected persistent `Agent` -> it runs a turn,
emitting `AgentEvent`s (text
chunks, activity lifecycle, questions, permission requests, usage updates)
-> `ChatViewProvider`
tags each with the agent id (for color-coding) and forwards it to the
webview, and routes the webview's answers back to the agent that asked.
After the delegated turn finishes, its outcome is written back into the
project session so later delegated agents receive the shared project history;
Groq remains a stateless Claude-versus-Codex classifier.
When an agent returns a structured quota failure, the host preserves that
same prompt and workspace, maps the selected model to the other provider's
nearest capability class, and makes one fallback attempt. Other errors never
trigger cross-provider reruns.

## Prerequisites

- A free [Groq](https://console.groq.com) API key, set via **"Orchestrator:
  Set Groq API Key"** (stored in VS Code's SecretStorage, never in
  settings.json). Routing runs on Groq instead of a local model — no local
  GPU/CPU load, and it doesn't compete with Claude/Codex's own rate limits
  since it's a separate provider.
- For routing during a Groq quota window, [Ollama](https://ollama.com) running
  locally with the configured fallback model pulled. The default is
  `qwen3:8b`; Groq remains the normal routing path.
- Optional final routing fallback: an [Ollama Cloud](https://docs.ollama.com/cloud)
  API key configured with
  **"Orchestrator: Set Ollama Cloud API Key"**. The key is stored in VS Code
  SecretStorage; an inherited `OLLAMA_API_KEY` environment variable also
  works. The default direct cloud host/model are `https://ollama.com` and
  `gpt-oss:20b`.
- The `claude` CLI ([Claude Code](https://docs.claude.com/en/docs/claude-code))
  installed and authenticated.
- Codex authentication configured locally. A matching native Codex CLI is
  bundled through `@openai/codex-sdk`; `orchestratorCode.codexCommand` can
  override it with another installed CLI.

## Settings

| Setting | Default | Description |
|---|---|---|
| `orchestratorCode.groqModel` | `llama-3.1-8b-instant` | Groq model used to route tasks — needs a key set via "Orchestrator: Set Groq API Key" |
| `orchestratorCode.ollamaBaseUrl` | `http://localhost:11434` | Local Ollama URL used while Groq routing is quota-limited or cannot return a valid decision |
| `orchestratorCode.ollamaModel` | `qwen3:8b` | Local model used for the Groq routing fallback |
| `orchestratorCode.ollamaCloudBaseUrl` | `https://ollama.com` | Direct Ollama Cloud host used if Groq and local Ollama are unavailable |
| `orchestratorCode.ollamaCloudModel` | `gpt-oss:20b` | Small cloud model used for final routing fallback |
| `orchestratorCode.claudeCommand` | `claude` | Claude Code CLI command |
| `orchestratorCode.codexCommand` | `codex` | Custom Codex CLI command; the default prefers the version bundled with the extension |
| `orchestratorCode.claudeModelAllowlist` | `["default", "sonnet", "opus", "haiku"]` | Claude models allowed for delegated work; the account default is preferred. Empty allows the complete catalog. |
| `orchestratorCode.codexModelAllowlist` | `[]` | Codex models allowed for delegated work; the account default is preferred. Empty allows every visible App Server model. |
| `orchestratorCode.mcpServers` | `["code-graph"]` | MCP server names (already defined in your global `~/.claude.json`) to mirror into the current workspace for both agents |

## Build and install

The extension contains platform-specific Claude and Codex runtime binaries,
so the build script detects the current operating system and architecture and
creates a matching VSIX under `dist/`.

```bash
npm ci
npm run package:vsix
```

To build and immediately install or update the extension in VS Code:

```bash
npm run install:vsix
```

The install command uses `code --install-extension <vsix> --force` and also
detects the standard macOS Visual Studio Code application path. If the VS Code
CLI has another name or path, provide it explicitly:

```bash
CODE_BIN=/path/to/code npm run install:vsix
```

After installation, reload VS Code. Then configure the Groq key and optionally
the Ollama Cloud key from the command palette. `VSCE_TARGET` can override the
auto-detected package target, but cross-platform packaging also requires the
matching native npm dependencies to be installed.

## MCP server sharing

Run **"Orchestrator: Sync MCP Servers to Claude & Codex"** from the command
palette. It reads the named servers from your global `~/.claude.json` and
writes them into:

- `<workspace>/.mcp.json` (Claude Code project-level config)
- `~/.codex/config.toml` under `[mcp_servers.<name>]` (+ a separate
  `[mcp_servers.<name>.env]` sub-table for env vars — the exact shape
  `codex mcp add` itself produces, confirmed by running it once and
  diffing the result; `codex mcp list`/`codex mcp get <name>` recognize a
  synced entry correctly)

Codex needs this step too, not just Claude — the Codex App Server loads
`~/.codex/config.toml`, the same as Claude Code loads its own project
`.mcp.json`, so a delegated Codex task only sees `code-graph` once this has
been run at least once on a given machine.

Only the server names you list in `orchestratorCode.mcpServers` are touched;
everything else in your Codex config is left alone. Because server configs
can carry secrets (API keys, database passwords, etc.), the generated
`.mcp.json` is gitignored by default in this repo's own `.gitignore` — treat
it the same way in any workspace you sync into.

## Scan button

The search icon on the chat panel's title bar (**"Orchestrator: Scan Project
into Code Graph"**) scans one selected workspace folder and imports it into the
shared `code-graph` Neo4j instance, tagged by project — the same
`scan_project` MCP tool Claude/Codex would call themselves, invoked directly
here via the MCP TypeScript SDK (`src/mcp/codeGraphClient.ts`), spawning
`code-graph`'s registered command from `~/.claude.json` for the duration of
one call. In a multi-root workspace the repository/folder picker is shown
first; a single-folder workspace skips that extra step. Flow:

1. In a multi-root workspace, you choose the exact repository to scan.
2. A cheap file-extension scan (`src/scan/detectLanguage.ts`) guesses the
   likely language and puts it first in the picker — never the only way to
   choose it. A selected language with no matching source files is rejected
   before invoking the MCP server.
3. You confirm/change the language in a QuickPick (`python`, `java`,
   `java-javaparser`, `javascript`, `cpp`, `cpp-clang` — see
   [code-graph-mcp](https://github.com/edeori/code-graph-mcp)'s own README
   for what each backend actually gives you).
4. You confirm/change the **project tag** in an input box (defaults to the
   workspace folder name) — this is what keeps multiple different
   apps/repos searchable within the *same* shared graph without colliding;
   rescanning the same tag replaces that project's own data, never anyone
   else's.
5. Results (files scanned, types imported) are shown as a notification and
   logged into the chat panel.

Requires `code-graph` to already be registered in your global
`~/.claude.json` (see code-graph-mcp's own setup instructions) — this
button doesn't configure that server itself, only calls it.

## Development

```bash
npm install
npm run watch
```

Press `F5` in VS Code to launch an Extension Development Host with the
extension loaded.

## Ideas for more MCP servers

Open discussion — candidates worth wiring in alongside `code-graph`:

- A filesystem/git-aware server for diff-aware context (avoid feeding whole files).
- A test-runner MCP server so agents can execute and read back test results directly.
- A docs/RAG server over internal wikis or API references.
- A terminal/process MCP server for longer-running builds, gated behind explicit approval.

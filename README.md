# Orchestrator Code

A VS Code extension that adds an activity-bar chat panel backed by a **local
LLM orchestrator**. You describe a task; a local Ollama model classifies it
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

## Status

- **Claude** — drives a real Claude Agent SDK session (`agents/claudeAgent.ts`),
  not a subprocess text-pipe. This is what makes the interactive
  question/permission dialogs and the live rate-limit gauge possible at all:
  - `AskUserQuestion` tool calls render as a real multi-choice dialog in the
    panel; your answer resumes the same session.
  - Every other tool needing approval (Bash, Write, Edit, ...) renders as an
    Allow once / Allow for session / Deny dialog, using the SDK's own
    pre-rendered prompt text (`"Claude wants to use Write"`, etc.).
  - A live usage bar tracks the 5-hour rate-limit window
    (`rate_limit_event` messages) and falls back to session cost
    (`total_cost_usd`) when rate-limit data isn't available (API-key
    sessions, for example).
  - All of the above verified live against a real session, not just typed
    against the SDK's declarations — see `agents/claudeAgent.ts`'s own
    comments for the two real gotchas that cost the most time: a
    pre-existing `~/.claude/settings.json` allow-rule can silently bypass
    `canUseTool` entirely unless `settingSources` excludes `'user'`, and
    `AskUserQuestion`'s resume payload is keyed by the **question's full
    text**, not an id/header, with multi-select answers comma-joined —
    both undocumented in the type declarations alone.
- **Codex** — still a deliberate placeholder (`agents/codexAgent.ts`): plain
  `codex exec` subprocess, text-only streaming, no interactive dialogs, no
  usage gauge. Codex's only richer control surface (`codex app-server`) is
  an explicitly `[experimental]`, undocumented, ~100-method internal
  protocol with no stable wire-format spec — building against it was
  deferred rather than reverse-engineering something that could break on
  any Codex update. See the class docstring for what was actually checked
  (including the official `@openai/codex-sdk`, which turned out not to
  expose an interactive approval callback either).
- MCP-server mirroring and the code-graph scan button work end-to-end for
  both agents already.

## Architecture

```
media/                  webview client (chat UI: HTML/CSS/JS)
src/extension.ts         activation, commands
src/webview/             WebviewViewProvider for the chat panel — owns
                         routing question/permission answers back to
                         whichever agent is currently running
src/orchestrator/        Ollama-based task router (claude vs codex)
src/agents/              agent.ts (shared interface), agentEvent.ts (the
                         normalized event model both agents emit),
                         claudeAgent.ts (Claude Agent SDK), codexAgent.ts
                         (CLI subprocess placeholder)
src/mcp/                 mirrors MCP server definitions to both CLIs; also a
                         direct MCP client used by the "Scan" button
src/scan/                best-effort language auto-detection for the picker
```

Flow: user message in webview -> `OllamaRouter.route()` classifies the task
-> the matching `Agent` runs it, emitting `AgentEvent`s (text chunks, tool
use, questions, permission requests, usage updates) -> `ChatViewProvider`
tags each with the agent id (for color-coding) and forwards it to the
webview, and routes the webview's answers back to the agent that asked.

## Prerequisites

- [Ollama](https://ollama.com) running locally, with a model pulled for
  routing (default `qwen2.5-coder:7b` — override via settings).
- The `claude` CLI ([Claude Code](https://docs.claude.com/en/docs/claude-code))
  installed and authenticated.
- The `codex` CLI ([OpenAI Codex](https://github.com/openai/codex))
  installed and authenticated.

## Settings

| Setting | Default | Description |
|---|---|---|
| `orchestratorCode.ollamaBaseUrl` | `http://localhost:11434` | Local Ollama server URL |
| `orchestratorCode.ollamaModel` | `qwen2.5-coder:7b` | Model used to route tasks |
| `orchestratorCode.claudeCommand` | `claude` | Claude Code CLI command |
| `orchestratorCode.codexCommand` | `codex` | Codex CLI command |
| `orchestratorCode.mcpServers` | `["code-graph"]` | MCP server names (already defined in your global `~/.claude.json`) to mirror into the current workspace for both agents |

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

Codex needs this step too, not just Claude — `codex exec` (what
`agents/codexAgent.ts` spawns) loads `~/.codex/config.toml` automatically
for any invocation, the same as Claude Code loads its own project
`.mcp.json`, so a delegated Codex task only sees `code-graph` once this has
been run at least once on a given machine.

Only the server names you list in `orchestratorCode.mcpServers` are touched;
everything else in your Codex config is left alone. Because server configs
can carry secrets (API keys, database passwords, etc.), the generated
`.mcp.json` is gitignored by default in this repo's own `.gitignore` — treat
it the same way in any workspace you sync into.

## Scan button

The search icon on the chat panel's title bar (**"Orchestrator: Scan Project
into Code Graph"**) scans the current workspace and imports it into the
shared `code-graph` Neo4j instance, tagged by project — the same
`scan_project` MCP tool Claude/Codex would call themselves, invoked directly
here via the MCP TypeScript SDK (`src/mcp/codeGraphClient.ts`), spawning
`code-graph`'s registered command from `~/.claude.json` for the duration of
one call. Flow:

1. A cheap file-extension scan (`src/scan/detectLanguage.ts`) guesses the
   likely language and puts it first in the picker — never the only way to
   choose it.
2. You confirm/change the language in a QuickPick (`java`,
   `java-javaparser`, `javascript`, `cpp`, `cpp-clang` — see
   [code-graph-mcp](https://github.com/edeori/code-graph-mcp)'s own README
   for what each backend actually gives you).
3. You confirm/change the **project tag** in an input box (defaults to the
   workspace folder name) — this is what keeps multiple different
   apps/repos searchable within the *same* shared graph without colliding;
   rescanning the same tag replaces that project's own data, never anyone
   else's.
4. Results (files scanned, types imported) are shown as a notification and
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

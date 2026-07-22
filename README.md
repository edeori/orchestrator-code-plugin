# Orchestrator Code

A VS Code extension that adds an activity-bar chat panel backed by a **local
LLM orchestrator**. You describe a task; a local Ollama model classifies it
and delegates the actual work to either the `claude` (Claude Code) or `codex`
(Codex CLI) command-line tool, streaming their output back into the chat.

Both agents can be given access to the same MCP servers (e.g. `code-graph`)
so they share one view of the codebase regardless of which one handles a
given task.

## Status

This is an early scaffold: the activity bar icon, chat webview, Ollama-based
router, CLI delegation, and MCP-server mirroring all work end-to-end, but the
routing prompt, CLI flags, and error handling are intentionally minimal and
meant to be iterated on.

## Architecture

```
media/                 webview client (chat UI: HTML/CSS/JS)
src/extension.ts        activation, commands
src/webview/            WebviewViewProvider for the chat panel
src/orchestrator/        Ollama-based task router (claude vs codex)
src/agents/              CLI subprocess wrappers for `claude` and `codex`
src/mcp/                 mirrors MCP server definitions to both CLIs
```

Flow: user message in webview -> `OllamaRouter.route()` classifies the task
-> the matching `Agent` spawns the corresponding CLI in the current
workspace folder -> stdout/stderr chunks are streamed back into the webview.

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
- `~/.codex/config.toml` under `[mcp_servers.<name>]`

Only the server names you list in `orchestratorCode.mcpServers` are touched;
everything else in your Codex config is left alone. Because server configs
can carry secrets (API keys, database passwords, etc.), the generated
`.mcp.json` is gitignored by default in this repo's own `.gitignore` — treat
it the same way in any workspace you sync into.

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

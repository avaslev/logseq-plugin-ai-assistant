# Logseq AI Assistant

[Русский](README.md) | **English**

[![GitHub release](https://img.shields.io/github/v/release/avaslev/logseq-plugin-ai-assistant)](https://github.com/avaslev/logseq-plugin-ai-assistant/releases)
[![License: MIT](https://img.shields.io/github/license/avaslev/logseq-plugin-ai-assistant)](LICENSE)

<p align="center"><img src="logo.svg" alt="Logseq AI Assistant" width="140"></p>

An OpenAI-compatible AI agent inside [Logseq](https://logseq.com). Conversations live in your graph: every session is a page under the `ai_assistant/` namespace, so history, search and links work like any other note.

## Features

- Streamed replies written into the session block in real time
- Graph tools: page and block search, tasks by status, page and block reading, selected blocks, DSL/Datalog queries, journal pages, recent pages
- Keyless web search: `web_search` and `fetch_page` via DuckDuckGo Lite
- Optional write tools for the open page: insert, update, remove and move blocks, set properties, create pages with confirmation
- Skills — reusable instructions stored in the graph, invoked explicitly via `/name` or picked by the model
- Editable system prompt on the `ai_assistant/system` page
- MCP servers over HTTP for external tools
- `/compress`, `/remove`, `/skill`, stop and Retry, message history, token estimate
- Large pastes collapse into attachments to keep the input compact
- Per-session model selection and Logseq theme-aware styling

## Installation

From the marketplace: `Plugins` → `Marketplace` → search for `logseq-ai-graph-assistant`.

From source:

```bash
npm install && npm run build
```

Then enable developer mode and choose `Plugins` → `Load unpacked plugin` → the project root. Details: [Installation](docs/install.md) (in Russian).

## Quick start

1. `Settings` → `Plugin Settings` → `AI Assistant` → set **API base URL** (e.g. `http://localhost:1234/v1` for LM Studio)
2. Reload the plugin and pick a **Default model**
3. Open the right sidebar in Logseq and send your first message

Any OpenAI-compatible server works: LM Studio, Ollama, OpenRouter, OpenAI and others. See [Configuration](docs/configuration.md) (in Russian) for examples and all settings.

## Documentation

The documentation is currently available in Russian:

| Section | What it covers |
|---|---|
| [Installation](docs/install.md) | Requirements, marketplace and manual install, updates, troubleshooting |
| [Configuration](docs/configuration.md) | All settings, API server examples, model and context behavior |
| [Agent tools](docs/tools.md) | Graph reading, web search, page editing, rules and safety |
| [Skills](docs/skills.md) | Skill pages, invocation, the system prompt page |
| [Commands and sessions](docs/commands.md) | Slash commands, sessions, history, Retry, tokens, large pastes |
| [MCP servers](docs/mcp.md) | Connecting external tools, stdio bridge, security |
| [Architecture](docs/architecture.md) | Internals: sessions, send pipeline, confirmations |
| [Development](docs/development.md) | Build, tests, releases, project layout |
| [FAQ](docs/faq.md) | Limitations, performance, privacy |

## Privacy

The plugin has no telemetry of its own. Requests go only to your API server; MCP servers and web tools touch the network only when enabled and called by the model. Sessions are stored locally in your graph.

## License

[MIT](LICENSE). Issues and suggestions: [GitHub Issues](https://github.com/avaslev/logseq-plugin-ai-assistant/issues).

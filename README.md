# aspire-discord

A Discord bot that answers Aspire questions from official documentation, commit-pinned source, and
read-only GitHub research. The runtime is intentionally polyglot:

- **Node.js/TypeScript** owns Discord, agent orchestration, GitHub Copilot, GitHub MCP, retrieval,
  safety, citations, and HTTP health.
- **.NET** owns ingestion, Roslyn API extraction, embeddings, and atomic Qdrant index publication.
- An official **Aspire TypeScript AppHost** orchestrates both services plus Qdrant and Ollama.

The bot refuses uncovered questions instead of filling gaps with model knowledge.

## Architecture

```text
aspire docs CLI ─┐
                 ├─> .NET ingestion ─> Qdrant generation aliases <─ Node agent/Discord <─> Discord
pinned Git src ──┘          │                         ▲                    │
                            └─ Ollama/cloud embeddings                    ├─ GitHub Copilot SDK
                                                                          └─ GitHub MCP (read-only)
```

An ingestion run builds documentation and API collections off-path. Qdrant aliases move only after
both generations are complete, so a failed refresh leaves the last usable index online.

## Projects

| Path | Runtime | Responsibility |
| --- | --- | --- |
| `AspireDiscordBot.AppHost` | TypeScript | Aspire resource graph, secrets, endpoints, health dependencies, commands |
| `AspireDiscordBot.Bot` | Node.js 24 + TypeScript | Discord gateway, grounded agent, MCP, Qdrant retrieval, health API |
| `AspireDiscordBot.Ingestion` | .NET 10 | Startup/scheduled/manual ingestion worker and admin API |
| `AspireDiscordBot.Core` | .NET 10 | Document readers, Roslyn extraction, embeddings, Qdrant generations |
| `AspireDiscordBot.ServiceDefaults` | .NET 10 | OpenTelemetry, resilience, and health defaults |
| `AspireDiscordBot.Tests` | .NET 10 | Ingestion and shared-index contract tests |

The replaced C# Discord and Copilot runtimes were removed; there is one production answer path.

## Prerequisites

- [Node.js 24](https://nodejs.org/) and npm 11
- [.NET 10 SDK](https://dotnet.microsoft.com/)
- [Aspire CLI 13.5](https://aspire.dev/get-started/install-cli/)
- [Git](https://git-scm.com/)
- Docker Desktop or Podman for Qdrant and Ollama
- A GitHub Copilot plan, unless using a configured BYOK chat provider
- A Discord application and bot token

GitHub Models is not used; that service was retired in July 2026.

## Configure Discord

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and bot.
2. Enable **Message Content Intent** only if `@mention` support is required.
3. Invite the bot with `bot` and `applications.commands` scopes.
4. Grant **Send Messages**, **Embed Links**, and **Use Application Commands**.
5. Add **Read Message History** to let `/ask` answer the original post in forum threads.

The gateway requests only `Guilds` unless mentions are enabled.

## Secrets

The TypeScript AppHost uses Aspire's native secret store:

```powershell
cd AspireDiscordBot.AppHost

aspire secret set Parameters:DiscordToken "DISCORD-BOT-TOKEN"
aspire secret set Parameters:GitHubMcpToken (gh auth token)
```

For Copilot, the SDK can reuse an existing `copilot`/`gh` login during local development. To pass
an explicit token:

```powershell
aspire secret set Parameters:CopilotGitHubToken "COPILOT-CAPABLE-TOKEN"
```

For unattended production services, use GitHub's documented GitHub App server-to-server Copilot
authentication and refresh installation tokens before expiry.

Do not use `aspire config set` for credentials. `aspire config` controls CLI settings; `aspire
secret` is the AppHost secret store.

## Install and run

From the repository root:

```powershell
npm ci
cd AspireDiscordBot.AppHost
aspire run
```

The AppHost:

1. Starts persistent Qdrant storage.
2. Starts Ollama when chat or embeddings require it.
3. Waits for the .NET ingestion service to publish compatible indexes.
4. Starts the Node bot and waits for `/ready`.

Ask through `/ask`, mention the bot, or invoke `/ask` without text inside a forum post/thread to
answer its starter message.

## TypeScript AppHost

`AspireDiscordBot.AppHost/apphost.mts` uses the generated Aspire SDK under `.aspire/modules`.
Generated files are not committed and must not be edited.

Restore or validate the AppHost with:

```powershell
cd AspireDiscordBot.AppHost
aspire restore
npm run typecheck
aspire publish --list-steps
```

The resource graph includes dashboard commands backed by the ingestion API:

- **Refresh index** → `POST /admin/reingest`
- **Force rebuild index** → `POST /admin/rebuild`

## Agent behavior

Each question follows the same bounded pipeline:

1. Deterministic input guard rejects prompt injection, jailbreaks, extraction attempts, empty input,
   and oversized questions.
2. The question is embedded and searched against `aspire_docs`.
3. A minimum similarity score gates unrelated or uncovered questions before model inference.
4. The agent receives a per-question tool budget and can query:
   - `search_docs`
   - `search_api`
   - repository-scoped GitHub code, file, tree, commit, issue, PR, and release tools
5. Tool output is bounded, sanitized, labeled untrusted, and registered with stable citations.
6. The final answer is checked for instruction leakage or successful persona manipulation.

The Copilot SDK runs in **`empty` mode**. Ambient shell, filesystem, Git, memory, skills, plugins,
schedule, and cross-session retrieval features are disabled. Every allowed tool is explicitly
registered and read-only.

## GitHub MCP

The Node service uses the official MCP TypeScript v2 client against:

```text
https://api.githubcopilot.com/mcp/
```

Controls are applied at both layers:

- `X-MCP-Readonly: true`
- `X-MCP-Lockdown: true`
- explicit tool allow-list
- application-enforced repository allow-list:
  - `microsoft/aspire`
  - `microsoft/aspire.dev`
- Boolean query branches and `org:`/`user:` scope expansion are rejected
- bounded pagination, output, timeout, connection retry, and result caching

Lockdown is a content filter, not an authorization boundary. Repository policy remains enforced by
the application.

## Ingestion

Published Aspire docs come from `aspire docs`. The public C# API surface comes from a managed bare
mirror of `microsoft/aspire`:

1. Resolve `ApiSurface:SourceRef` to an immutable commit.
2. Export only `src`.
3. Parse public types, members, signatures, and XML documentation with Roslyn.
4. Embed chunks in batches.
5. Build physical Qdrant generations.
6. Atomically move the `aspire_docs` and `aspire_api` aliases.

Point payloads include revision, content hash, extractor version, embedding provider/model,
dimensions, generation, and ingestion timestamp. Commit-pinned citations cannot drift with `main`.

## AI providers

Chat and embeddings are configured independently.

| Chat provider | `Parameters:AiProvider` | Notes |
| --- | --- | --- |
| GitHub Copilot | `copilot` | Default; official Copilot SDK |
| Azure OpenAI | `azureopenai` | BYOK Responses API |
| Azure AI Foundry | `azureaifoundry` | BYOK OpenAI-compatible Responses API |
| OpenAI | `openai` | BYOK Responses API |
| Ollama | `ollama` | Local chat-completions API |

With Copilot chat, embeddings default to AppHost-managed Ollama:

```text
nomic-embed-text, 768 dimensions
```

Example cloud override:

```powershell
cd AspireDiscordBot.AppHost
aspire secret set Parameters:AiEmbeddingApiKey "EMBEDDING-KEY"
aspire secret set Parameters:AiApiKey "CHAT-KEY"
```

Configure non-secret values using AppHost configuration/environment:

```text
Parameters__AiProvider=azureopenai
Parameters__AiEndpoint=https://RESOURCE.openai.azure.com
Parameters__AiChatModel=CHAT-DEPLOYMENT
Parameters__AiEmbeddingProvider=azureopenai
Parameters__AiEmbeddingEndpoint=https://RESOURCE.openai.azure.com
Parameters__AiEmbeddingModel=EMBEDDING-DEPLOYMENT
Parameters__AiEmbeddingDimensions=1536
```

Embedding credentials are never inherited across different providers.

## Discord options

| Parameter | Default | Description |
| --- | --- | --- |
| `Parameters:DiscordGuildId` | unset | Guild-scoped command registration for immediate development updates |
| `Parameters:DiscordMentionEnabled` | `true` | Enables mention handling and Message Content intent |
| `Parameters:DiscordAllowedUserIds` | empty | Comma-separated Discord user IDs; empty allows everyone |

The gateway replaces the command set idempotently on startup instead of creating duplicates.
Concurrent answers and queued requests are bounded; excess work gets a retry response.

## HTTP endpoints

The Node bot exposes:

- `GET /health` — process liveness
- `GET /ready` — Discord state plus both Qdrant aliases
- `GET /status` — gateway latency, guild count, mention mode, and work queue
- `GET /scalar` — Scalar API reference

The ingestion service exposes:

- `GET /ready`
- `GET /admin/status`
- `POST /admin/reingest`
- `POST /admin/rebuild`
- `GET /scalar`

## Tests and quality gates

Run all Node and .NET checks:

```powershell
npm run build
npm run typecheck
npm run lint
npm test
npm run format:check
```

The deterministic TypeScript core enforces global coverage thresholds and currently covers config,
safety, prompts, citations, repository policy, answer orchestration, formatting, overload control,
and HTTP behavior.

Target individual suites:

```powershell
npm run test:unit
npm run test:e2e
npm run test:integration
```

Opt-in live integrations:

```powershell
$env:GITHUB_MCP_TEST_TOKEN = gh auth token
$env:QDRANT_TEST_URL = "http://127.0.0.1:6333"
$env:QDRANT_TEST_ENDPOINT = "http://127.0.0.1:6334"

npm run test:integration --workspace @aspire-discord/bot
npm run test:dotnet
```

The integration suites exercise the bundled Copilot runtime, remote GitHub MCP, Node Qdrant reads,
.NET generation swaps, failed-refresh preservation, and legacy alias migration.

## Package feeds

`nuget.config` pins the internal mirrors required in this environment for Aspire and .NET packages.
Node dependencies are locked by the root `package-lock.json`.

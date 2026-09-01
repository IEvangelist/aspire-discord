# aspire-discord

A Discord bot that answers Aspire questions from official documentation, commit-pinned source, and
read-only GitHub research. The runtime is intentionally polyglot:

- **Node.js/TypeScript** owns Discord, agent orchestration, GitHub Copilot, GitHub MCP, retrieval,
  safe linked-context fetching, safety, citations, progress updates, and HTTP health.
- **.NET** owns ingestion, Roslyn API extraction, embeddings, and versioned vector-index
  publication.
- An official **Aspire TypeScript AppHost** orchestrates both services plus Qdrant. Ollama is an
  explicit local-development fallback.

The bot refuses uncovered questions instead of filling gaps with model knowledge.

## Architecture

```text
aspire docs CLI ─┐
                 ├─> .NET ingestion ─> vector index aliases <─ Node agent/Discord <─> Discord
pinned Git src ──┘          │                         ▲                    │
                            └─ Foundry embeddings                         ├─ GitHub Copilot SDK
                               (Ollama opt-in)                            └─ GitHub MCP (read-only)
```

An ingestion run builds documentation and API indexes off-path. Logical aliases move only after
both generations are complete, so a failed refresh leaves the last usable indexes online.

## Projects

| Path                               | Runtime                 | Responsibility                                                           |
| ---------------------------------- | ----------------------- | ------------------------------------------------------------------------ |
| `AspireDiscordBot.AppHost`         | TypeScript              | Aspire resource graph, secrets, endpoints, health dependencies, commands |
| `AspireDiscordBot.Bot`             | Node.js 24 + TypeScript | Discord gateway, grounded agent, MCP, vector retrieval, health API       |
| `AspireDiscordBot.Ingestion`       | .NET 10                 | Startup/scheduled/manual ingestion worker and admin API                  |
| `AspireDiscordBot.Core`            | .NET 10                 | Document readers, Roslyn extraction, embeddings, vector generations      |
| `AspireDiscordBot.ServiceDefaults` | .NET 10                 | OpenTelemetry, resilience, and health defaults                           |
| `AspireDiscordBot.Tests`           | .NET 10                 | Ingestion and shared-index contract tests                                |

The replaced C# Discord and Copilot runtimes were removed; there is one production answer path.

## Prerequisites

- [Node.js 24](https://nodejs.org/) and npm 11
- [.NET 10 SDK](https://dotnet.microsoft.com/)
- [Aspire CLI 13.5](https://aspire.dev/get-started/install-cli/)
- [Git](https://git-scm.com/)
- Docker Desktop or Podman for Qdrant
- A GitHub Copilot plan, unless using a configured BYOK chat provider
- An Azure AI Foundry embedding deployment and an identity with the
  **Cognitive Services OpenAI User** role
- A Discord application and bot token

GitHub Models is not used; that service was retired in July 2026.

## Configure Discord

In the [Discord Developer Portal](https://discord.com/developers/applications):

1. Create an application and bot.
2. Enable **Message Content Intent** so mentions, replies, attachments, and thread context are visible.
3. Invite the bot with the `bot` scope.
4. Grant **View Channels**, **Send Messages**, and **Send Messages in Threads**.
5. Add **Read Message History** so mentions can use recent forum-thread conversation context.

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

Foundry embeddings use Microsoft Entra ID instead of a stored API key. Run `az login` for local
development. In Azure, assign the same role to the application's managed identity.

For unattended production services, use GitHub's documented GitHub App server-to-server Copilot
authentication and refresh installation tokens before expiry.

Do not use `aspire config set` for credentials. `aspire config` controls CLI settings; `aspire
secret` is the AppHost secret store.

## Install and run

From the repository root:

```powershell
npm ci
cd AspireDiscordBot.AppHost
$env:Parameters__AiEmbeddingEndpoint = "https://YOUR-RESOURCE.openai.azure.com"
aspire run
```

The AppHost:

1. Starts persistent Qdrant storage.
2. Uses Azure AI Foundry embeddings with Entra authentication by default.
3. Waits for the .NET ingestion service to publish compatible indexes.
4. Starts the Node bot and waits for `/ready`.

Ollama starts only when local AI is explicitly enabled.

Mention the bot wherever the question naturally occurs:

```text
@Aspirey Bot How do I add Redis to an Aspire app?
```

The mention is the only Q&A entry point. It can contain a direct question, reply to another message,
carry an immutable forwarded-message snapshot, or appear inside a forum post/thread. Images and
bounded UTF-8 code, configuration, Markdown, JSON, and log files can be attached directly to the
mention.

Inside a forum post/thread, a mention includes the forum title and tags plus a bounded,
chronological snapshot of the starter, recent participant replies, and prior bot answers. A bare
mention answers the latest readable user turn. Attachments and true inline image embeds from the
current mention, replied-to or forwarded message, latest thread turn, and starter are considered
using deterministic precedence. Article/link-preview thumbnails are ignored.

All user content, history, files, and images are untrusted observations, never authoritative
evidence. Common credential and private-key patterns are redacted before model or embedding calls,
images are normalized in memory, and factual guidance is still grounded in official Aspire sources.
Invalid explicit attachments fail closed; invalid optional thread context is skipped with a visible
context note.

| Input combination               | Deterministic behavior                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| Typed question plus any context | Typed question wins; context informs retrieval                     |
| Current image/file without text | Current attachment becomes the active question                     |
| Forwarded snapshot              | Forwarded message wins over reply/thread fallbacks                 |
| Reply mention                   | Replied-to message wins over thread history                        |
| Bare mention in a thread        | Latest human turn wins; forum title is the final fallback          |
| Unsafe current turn             | Request is blocked; older questions are never substituted          |
| Unreadable optional context     | Remaining context is used and a visible note explains the omission |

Answers use standard Discord reply chains rather than fixed-width embeds. The first reply contains
the focused answer, long-answer continuations reply to it in order, and grounded sources plus
context notes follow as replies instead of lengthening the answer. While an answer is running, the
bot edits one status message through link checking, documentation search, research, and writing
phases while refreshing Discord's typing indicator.

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
   and questions over 2,000 characters.
2. User-provided links are extracted before retrieval. Supported GitHub issue, PR, commit,
   latest-release, and file links are routed through repository-scoped read tools. Other links must
   use HTTPS and match an exact administrator-approved host.
3. Current-version questions resolve the live GitHub latest release. They fail closed if that
   authoritative lookup is unavailable.
4. The question and bounded linked context are searched against `aspire_docs`.
5. Historical versioned `whats-new` pages are excluded from the index and filtered from old index
   generations. Current docs, current source, and evergreen guidance take precedence.
6. A minimum similarity score gates unrelated or uncovered questions before model inference.
7. The agent receives a per-question tool budget and can query:
   - `search_docs`
   - `search_api`
   - repository-scoped GitHub code, file, tree, commit, issue, PR, and release tools
8. Tool and linked output is bounded, sanitized, labeled untrusted, and registered with citations.
9. The final answer is checked for instruction leakage or successful persona manipulation.

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
- explicit tool allow-list
- application-enforced repository allow-list:
  - `microsoft/aspire`
  - `microsoft/aspire.dev`
- Boolean query branches and `org:`/`user:` scope expansion are rejected
- bounded pagination, output, timeout, connection retry, and result caching

The server's lockdown content filter is intentionally not enabled because it requires push access
before reading public issues. Write protection is still enforced by the server read-only header,
the exact read-tool list, and the application's repository and argument policies.

Non-GitHub URL fetching is separately constrained to exact HTTPS hosts, validates every redirect,
accepts text content only, reads at most 1 MiB, returns at most 12,000 characters, and never forwards
credentials or cookies. Fetched text remains untrusted model context.

## Ingestion

Published Aspire docs come from the configured CLI, GitHub, or local source. Versioned release-note
pages are omitted; live release metadata comes from GitHub. The public C# API surface comes from a
managed bare mirror of `microsoft/aspire`:

1. Resolve `ApiSurface:SourceRef` to an immutable commit.
2. Export only `src`.
3. Parse public types, members, signatures, and XML documentation with Roslyn.
4. Embed chunks in batches.
5. Build physical vector-index generations.
6. Publish the `aspire_docs` and `aspire_api` aliases with rollback on failure.

Point payloads include revision, content hash, extractor version, embedding provider/model,
dimensions, generation, and ingestion timestamp. Commit-pinned citations cannot drift with `main`.

## AI providers

Chat and embeddings are configured independently. The default hosted path uses GitHub Copilot for
chat and Azure AI Foundry for embeddings.

| Chat provider    | `Parameters:AiProvider` | Notes                                    |
| ---------------- | ----------------------- | ---------------------------------------- |
| GitHub Copilot   | `copilot`               | Default; official Copilot SDK            |
| Azure OpenAI     | `azureopenai`           | BYOK Responses API                       |
| Azure AI Foundry | `azureaifoundry`        | BYOK OpenAI-compatible Responses API     |
| OpenAI           | `openai`                | BYOK Responses API                       |
| Ollama           | `ollama`                | Explicit local chat-completions fallback |

Foundry embeddings use the OpenAI-compatible v1 API and `DefaultAzureCredential` in both the Node
bot and .NET ingestion service. Configure the resource endpoint without `/openai/v1`; the clients
append that route.

```powershell
$env:Parameters__AiEmbeddingEndpoint = "https://YOUR-RESOURCE.openai.azure.com"
$env:Parameters__AiEmbeddingModel = "text-embedding-3-small"
$env:Parameters__AiEmbeddingDimensions = "1536"
```

The model value is the Foundry deployment name. The default is `text-embedding-3-small`.

For fully local development without hosted AI access, explicitly enable Ollama:

```powershell
cd AspireDiscordBot.AppHost
$env:Ollama__Enabled = "true"
aspire run
```

Local mode switches both chat and embeddings to AppHost-managed Ollama. It uses `llama3.1` for chat
and `nomic-embed-text` with 768 dimensions for embeddings.

## Deploy to Azure

The `infra` deployment targets Azure Container Apps in Central US. It provisions:

- GPT-5.6 Sol and `text-embedding-3-small` in Microsoft Foundry
- Azure AI Search with versioned indexes and aliases
- Azure App Configuration for live operational settings
- a user-assigned managed identity for Foundry, Search, App Configuration, Application Insights,
  and Azure Container Registry
- a blue/green Container Apps deployment containing the bot and ingestion worker
- Application Insights, Log Analytics, and a Basic container registry

Foundry local authentication is disabled. The bot and ingestion worker use managed identity in
Azure, so the deployment does not use a personal GitHub Copilot login or AI/Search API keys.

The Aspire deployment pipeline reads `DiscordToken`, `GitHubMcpToken`, and a fallback Discord user
allowlist from the local Aspire secret store. It also accepts `DISCORD_TOKEN`, `GITHUB_MCP_TOKEN`,
and `DISCORD_ALLOWED_USER_IDS` environment variables for CI. The fallback allowlist seeds Azure App
Configuration on first deployment and remains available if live configuration cannot be loaded
during a restart.

Build and deploy immutable images:

```powershell
aspire deploy `
  --apphost .\AspireDiscordBot.AppHost\apphost.mts `
  --environment Production
```

`aspire deploy` resolves an explicit pipeline:

1. `production-preflight` requires committed source, validates Azure access, and compiles every
   Bicep template.
2. `production-blue-green` acquires the Azure deployment lease, builds immutable Git-tagged images,
   stages the inactive slot without Discord, waits for both Search aliases, cuts over the singleton
   Discord connection, and restores the prior slot if cutover fails.

The compatibility command `.\infra\deploy.ps1` now delegates to this same Aspire pipeline. Use its
`-StopLocalAppHost` switch when a local Aspire instance is running. The internal
`infra\deploy-production.ps1` implementation rejects direct execution so there is only one
supported deployment entry point.

After a successful migration from the older Qdrant deployment, the script removes the unsupported
NFS-backed Container App and storage account.

### Live runtime configuration

Production reads operational settings from Azure App Configuration with managed identity and checks
for changes every 15 seconds. Updating these values does not rebuild an image, create a Container Apps
revision, restart the process, or run `aspire deploy`. Invalid or unavailable remote values leave the
last valid settings active. A cold start cannot become ready until the initial remote settings load,
so an App Configuration outage never turns a missing allowlist into open access.

Use the helper to update settings safely:

```powershell
# Add or remove allowlisted Discord users.
.\infra\set-runtime-config.ps1 -AddDiscordUserId 347827564880068608
.\infra\set-runtime-config.ps1 -RemoveDiscordUserId 347827564880068608
# Opening access requires an explicit opt-in.
.\infra\set-runtime-config.ps1 -AllowOpenAccess

# Change how grounded sources render.
.\infra\set-runtime-config.ps1 -GroundingDetailsMode collapsed
```

`collapsed` renders up to five sources as a compact row of link buttons, `expanded` renders the
existing text list, and `hidden` omits source links. The same values can be edited directly in the
Azure portal under these keys:

```text
AspireDiscord:Discord:AllowedUserIds
AspireDiscord:Discord:GroundingDetailsMode
```

### Production observability

The production deployment sends structured container logs to the 30-day Log Analytics workspace and
exports correlated logs, traces, exceptions, runtime metrics, GenAI telemetry, Discord request
outcomes, and ingestion-run metrics to workspace-based Application Insights. Telemetry ingestion uses
the Container App's managed identity. Discord message content and attachment contents are never
written to telemetry; request records contain IDs, dimensions, durations, counts, and outcomes only.

The `/status` endpoint reports Discord connectivity, queue depth, live configuration source and
revision, grounding-detail mode, and whether access is open or allowlisted. Every bot mention that
reaches the gateway records one of these outcomes:
`answered`, `not_grounded`, `not_authorized`, `rate_limited`, `duplicate`, `invalid_question`,
`busy`, `image_rejected`, `text_rejected`, or `failed`.

Useful Log Analytics queries:

```kusto
// Find rejected or failed Discord mentions and their trace IDs.
ContainerAppConsoleLogs_CL
| where ContainerAppName_s startswith "aspire-discord-"
| extend entry = parse_json(replace_regex(Log_s, @"^[A-Z]\s+", ""))
| where tostring(entry.outcome) in ("not_authorized", "rate_limited", "busy", "failed")
| project TimeGenerated,
          outcome=tostring(entry.outcome),
          discordUserId=tostring(entry.discordUserId),
          discordMessageId=tostring(entry.discordMessageId),
          traceId=tostring(entry.trace_id),
          message=tostring(entry.msg)
| order by TimeGenerated desc
```

```kusto
// Follow one Discord request across logs, dependencies, exceptions, and traces.
let traceId = "<trace-id>";
union AppRequests, AppDependencies, AppTraces, AppExceptions
| where OperationId == traceId
| order by TimeGenerated asc
```

```kusto
// Request outcomes over the last 24 hours.
AppMetrics
| where TimeGenerated > ago(24h)
| where Name == "aspire.discord.requests"
| extend outcome = tostring(Properties["aspire.discord.request.outcome"])
| summarize Requests=sum(Sum) by bin(TimeGenerated, 1h), outcome
| order by TimeGenerated desc

// Average request latency over the last 24 hours.
AppMetrics
| where TimeGenerated > ago(24h)
| where Name == "aspire.discord.request.duration"
| extend outcome = tostring(Properties["aspire.discord.request.outcome"])
| summarize TotalDuration=sum(Sum), Samples=sum(ItemCount) by outcome
| extend AverageDurationSeconds=TotalDuration / Samples
| project outcome, AverageDurationSeconds, Samples
```

The defaults deploy to resource group `aspire-discord-prod` in subscription
`11aa9ca6-306a-4ea9-b614-2d413efd04a8`. Override `Azure__SubscriptionId`,
`Azure__ResourceGroup`, `Azure__Location`, or `Parameters__DeploymentResourceSuffix` to target
another environment. Set `Parameters__DeploymentSkipBuild=true` only when the current commit's
immutable images already exist in the target registry.

Other cloud providers remain available through AppHost configuration:

```text
Parameters__AiProvider=azureopenai
Parameters__AiEndpoint=https://RESOURCE.openai.azure.com
Parameters__AiChatModel=CHAT-DEPLOYMENT
Parameters__AiEmbeddingProvider=azureopenai
Parameters__AiEmbeddingEndpoint=https://RESOURCE.openai.azure.com
Parameters__AiEmbeddingModel=EMBEDDING-DEPLOYMENT
Parameters__AiEmbeddingDimensions=1536
```

For key-based providers, configure `Parameters:AiApiKey` and `Parameters:AiEmbeddingApiKey` through
the Aspire secret store. Credentials are never inherited across different providers or endpoints.

## Discord options

| Parameter                                | Default                         | Description                                                               |
| ---------------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `Parameters:DiscordGuildId`              | unset                           | Optional legacy guild-command scope to clear during startup               |
| `Parameters:DiscordMentionEnabled`       | `true`                          | Enables `@mention` questions and Message Content intent                   |
| `Parameters:DiscordAllowedUserIds`       | empty                           | Local/fallback user IDs; production uses live configuration               |
| `Parameters:DiscordGroundingDetailsMode` | `collapsed`                     | Local/fallback source mode: `collapsed`, `expanded`, or `hidden`           |
| `Parameters:DiscordMaxRequestsPerMinute` | `10`                            | Per-user request limit for mention-driven questions                       |
| `Parameters:SafetyMaxQuestionLength`     | `2000`                          | Maximum direct or thread-turn question characters                         |
| `Parameters:ImageContextEnabled`         | enabled for `gpt-5.6-sol`       | Enables validated in-memory image context for a vision-capable chat model |
| `Parameters:ImageContextMaxImages`       | `1`                             | Maximum images sent; latest user image is preferred over the starter      |
| `Parameters:ImageContextMaxBytes`        | `3145728`                       | Maximum encoded bytes accepted per source or normalized image             |
| `Parameters:ImageContextMaxPixels`       | `16000000`                      | Maximum decoded pixels accepted per image                                 |
| `Parameters:TextContextEnabled`          | `true`                          | Enables bounded UTF-8 code, config, Markdown, JSON, and log attachments   |
| `Parameters:TextContextMaxFiles`         | `2`                             | Maximum text attachments considered per request                           |
| `Parameters:TextContextMaxBytes`         | `262144`                        | Maximum downloaded bytes per text attachment                              |
| `Parameters:TextContextMaxCharacters`    | `12000`                         | Aggregate text attachment characters included in model context            |
| `Parameters:LinkContextAllowedHosts`     | official Aspire/Microsoft hosts | Exact HTTPS hosts available to bounded linked-context fetching            |
| `Parameters:LinkContextMaxUrls`          | `3`                             | Maximum user-provided links resolved per question                         |

The gateway idempotently clears legacy application commands on startup. Concurrent answers and
queued requests are bounded; excess work gets a retry response.

## HTTP endpoints

The Node bot exposes:

- `GET /health` — process liveness
- `GET /ready` — Discord state plus both configured vector-index aliases
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
$env:AZURE_SEARCH_TEST_ENDPOINT = "https://SEARCH-SERVICE.search.windows.net"

npm run test:integration --workspace @aspire-discord/bot
npm run test:dotnet
```

The integration suites exercise the bundled Copilot runtime, remote GitHub MCP, Node retrieval,
.NET generation swaps, failed-refresh preservation, and both Qdrant and Azure AI Search backends.

## GenAI telemetry

The Node agent, Copilot SDK runtime, and .NET embedding client emit OpenTelemetry GenAI spans and
metrics using the standard `gen_ai.*` conventions. The local Aspire Dashboard recognizes agent,
chat, embedding, and tool operations and shows model, duration, token, and error details in its
GenAI visualizer.

Prompt, response, tool-argument, and tool-result content is captured only when `NODE_ENV` is
`development`, so the local dashboard can populate its input and output panels. Production keeps
content capture disabled and does not write Discord question text to application logs. It records
only content-free outcome, duration, citation count, similarity, question-source, and modality-count
metadata for operational tuning.

## Package feeds

`nuget.config` pins the internal mirrors required in this environment for Aspire and .NET packages.
Node dependencies are locked by the root `package-lock.json`.

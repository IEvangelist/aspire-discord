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
chronological snapshot of the starter, recent participant replies, and prior bot answers.
Short requests such as "can you help" and "this" resolve their topic from the direct reply
first, otherwise the thread starter, then a readable recent turn. A bare mention requests help
with that topic; historical issue-filing instructions never become a new request to create an
issue. For an inferred help request, the issue-draft tool is not even offered to the agent;
an explicit current requester drafting request is required to make it available. Direct replies
follow up to four ancestors, including bot answer/detail chains. Thread
reads fetch the starter and the latest 50 messages; a vague request can page through at most
three more 50-message batches. At most 20 turns and 8,000 characters enter the agent context.
Omitted or unreadable older history is reported, never presented as complete. Attachments and
true inline image embeds from the current mention, replied-to or forwarded message, latest
thread turn, and starter are considered using deterministic precedence. Article/link-preview
thumbnails are ignored.

All user content, history, files, and images are untrusted observations, never authoritative
evidence. Common credential and private-key patterns are redacted before model or embedding calls,
images are normalized in memory, and factual guidance is still grounded in official Aspire sources.
Invalid explicit attachments fail closed; invalid optional thread context is skipped with a visible
context note.

| Input combination               | Deterministic behavior                                             |
| ------------------------------- | ------------------------------------------------------------------ |
| Substantive current request     | Current requester chooses the action; context provides only a topic |
| Short "this"/"can you help"     | Ask about the replied-to question, or the safe thread starter       |
| Current image/file without text | Current attachment becomes the active question                     |
| Forwarded snapshot              | Clear forwarded topic precedes reply/thread topics                  |
| Reply to a bot answer           | Follow the bounded chain to the human question                     |
| Bare mention in a thread        | Ask about the starter or latest readable topic, never execute it    |
| Unsafe current turn             | Request is blocked; older questions are never substituted          |
| Unreadable or truncated context | Use what is available and visibly note what was omitted             |

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

The production gateway uses one bounded Copilot conversation agent to select capabilities. It does
not classify natural-language requests with issue/read keyword matchers before the model sees tools.

1. Deterministic input guard rejects prompt injection, jailbreaks, extraction attempts, empty input,
   and questions over 2,000 characters.
2. The agent receives the current request, bounded requester history, and pending draft fields.
3. It selects read-only documentation, API, GitHub, activity-report, or allowlisted-link tools:
   - `search_docs`
   - `search_api`
   - repository-scoped GitHub code, file, tree, commit, issue, PR, and release tools
4. `prepare_issue_draft` accepts typed repository/title/body fields. When the requester asks to
   draft from a report or discussion, the agent proposes a concise title and structured description
   from that context, including another participant's reported observations. Unknowns and uncertainty
   remain explicit; the draft never claims reproduction or invents versions. Explicit title/body
   overrides are preserved. The agent selects the obvious repository from the affected component:
   product/runtime/tooling defects target `microsoft/aspire`; documentation/site defects target
   `microsoft/aspire.dev`. An explicit requester choice takes precedence. Only genuinely ambiguous
   reports need a repository question, retaining proposed fields instead of asking for the report again.
   When useful, a few focused read-only source, documentation, issue or PR lookups enrich the description.
   Reported behavior stays separate from source-backed findings, hypotheses and unknowns. The optional
   `investigation` field requires citations from this turn's actual tool results; the preview converts
   them into portable source links inside an "Investigation (read-only)" section. Failed or inconclusive
   lookups must not become claims of reproduction, a confirmed root cause, or an exhaustive duplicate
   search. Simple test issues and explicitly verbatim bodies do not require investigation.
   This tool can deliver a durable preview, never publish it.
5. `ask_clarification` asks for genuinely missing information; `acknowledge_feedback` responds briefly
   to frustration or thanks without a documentation search or another clarification loop.
   `cancel_pending_request` clears an unfinished conversation.
6. Tool and linked output is bounded, sanitized, labeled untrusted, and registered with citations.
   Technical answers still require retrieved evidence; historical release pages are not current facts.
7. User/server/repository authorization, rate limits, duplicate protection, and exact requester
   approval before publication are enforced in code, independently of model decisions.

The Copilot SDK runs in **`empty` mode**. Ambient shell, filesystem, Git, memory, skills, plugins,
schedule, and cross-session retrieval features are disabled. Every allowed tool is explicitly
registered. Its only non-read capability prepares an issue preview; no publishing or approval tool
is exposed to the model.

### Follow-up continuity

Short replies such as `aspire.dev` continue the pending task, with or without another mention, only
for the same requester in the same server and channel/thread. Other people's messages are not
consumed as answers. Per-requester turns are serialized to avoid racing two draft continuations.
Recent conversation context is redacted and bounded to 8,000 characters, 500 conversations and
ten minutes in memory. Bounded report context (up to 8,000 additional characters) is retained
separately from requester instructions while a task is pending; it never supplies authorization.
Completion, cancellation or expiry stops passive follow-up capture. A feedback acknowledgment
also stops passive capture while retaining pending fields for an explicit mention to resume.
Conversation memory is not durable across restart; already-created previews and publication state
remain durable in Azure Tables, and direct replies to those previews retain their existing controls.

Clarifications and acknowledgments use a single short reply without repeating the request or adding
another status message. Successful issue preparation replaces the progress reply with one preview:
the complete outgoing title/body, repository visibility, limitations, duplicates and approval controls.
There is no duplicate body attachment or separate "preview ready" reply. Only the requester can
publish that exact version; a plain "yes" is not approval.

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

### GitHub reports and read-only operations

GitHub read requests do not require a match in the documentation index. For example,
`@Aspirey Bot look at issue reports from afscrome this month` queries authored issues in both
`microsoft/aspire` and `microsoft/aspire.dev`, including open and closed reports, and returns
counts and links. PR reports and broader user-activity requests use the same repository allowlist.
The agent converts relative dates using the current UTC date into validated date arguments.
Invalid/ambiguous usernames or unsupported date ranges request clarification; an activity report
must supply an explicit bounded date window rather than silently interpreting an unsupported filter.

Reports distinguish issue/PR authorship from comments, reviews and commits. They state the
categories, pagination, sample and API limitations rather than claiming to enumerate every GitHub
event. A successful zero-result search is different from missing credentials, a rate limit or a
failed repository lookup. Other repository questions use only the existing read-only GitHub tools
with explicit page limits and source citations, not issue-publishing credentials or tools.
Issue creation remains a separate, requester-approved workflow; this read path cannot write to GitHub.
Activity snapshots cover authored issues/PRs, new issue/review comments, submitted PR reviews, and
default-branch commits (filtered by committer date). Reactions, deleted activity, branch pushes,
discussions and other events are not included. Bounds are 300 search results per repository,
200 records per activity endpoint, four review candidates, 40 requests, 12 seconds per request,
and 60 seconds overall. A summary may show a labeled sample of ten retrieved records.

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
   relevant Bicep template (only `app.bicep` when reusing the foundation).
2. `production-blue-green` acquires the Azure deployment lease, builds immutable Git-tagged images,
   stages the inactive slot without Discord, waits for both Search aliases, cuts over the singleton
   Discord connection, and restores the prior slot if cutover fails.

The compatibility command `.\infra\deploy.ps1` now delegates to this same Aspire pipeline. Use its
`-StopLocalAppHost` switch when a local Aspire instance is running. The internal
`infra\deploy-production.ps1` implementation rejects direct execution so there is only one
supported deployment entry point.

After a successful migration from the older Qdrant deployment, the script removes the unsupported
NFS-backed Container App and storage account.

### Issue-filing rollout without foundation changes

Issue filing uses GitHub App **4968096**, installation **163850423**, a version-pinned
Key Vault signing key, and managed-identity Azure Table storage. No PEM, storage
account key, or new Key Vault role is supplied to the application.

The existing private vault `aspire-issues-ffccd7` and its previously approved
key-scoped runtime identity grant are prerequisites, not deployment resources in
this release. Neither application deployment nor `issue-storage` changes the
vault, network, DNS, NSGs, Search, Foundry, or telemetry retention.
`infra\issue-vault.bicep`, `infra\issue-vault-access.bicep`, and
`infra\private-endpoint-network.bicep` preserve the source of the earlier approved
vault deployment; they are **not registered in either rollout scope**. Do not
reapply them during this rollout (Azure-managed NSG rules must be preserved).
The access template retains its custom-role default and explicit
`builtin-key-scoped` opt-in; production already has the separately approved
key-scoped Crypto User grant, so neither mode runs here.

After reviewing and committing the release, provision the isolated storage scope:

```powershell
$env:Azure__SubscriptionId = '11aa9ca6-306a-4ea9-b614-2d413efd04a8'
$env:Azure__ResourceGroup = 'aspire-discord-prod'
$env:Azure__Location = 'centralus'
$env:Parameters__DeploymentScope = 'issue-storage'
aspire publish --apphost .\AspireDiscordBot.AppHost\apphost.mts --environment Production --non-interactive -o .\AspireDiscordBot.AppHost\.aspire\issue-storage-preview
aspire deploy --apphost .\AspireDiscordBot.AppHost\apphost.mts --environment Production --non-interactive
```

The storage resource is owned by the AppHost, but its custom Aspire deployment step applies only a
resource-group-scoped incremental deployment to the existing group. Native Azure provisioning is
disconnected from this scope's `deploy` graph and guarded against direct invocation: Aspire 13.5.3's
native context can otherwise fall back to creating/updating the group after a failed lookup.
The custom step repeats read-only prerequisite checks immediately before deployment and propagates
any failure without creating a group or rewriting its tags. Use `aspire deploy`, not the published
subscription-level `main.bicep` wrapper, to preserve this existing-only behavior.

This scope creates only `aspireissuesffccd7` (`StorageV2`, `Standard_LRS`, TLS 1.2,
shared keys disabled, OAuth default, anonymous blob access disabled), the table
service and `IssueDrafts` table, and **Storage Table Data Contributor**
(`0a9a7e1f-b9d0-4cc4-a60d-0319b160aaa3`) scoped **only to that table**, for existing
runtime principal `16d6bfa3-79e5-4da5-b2d8-b76672588040`. It creates no custom role
definitions or new identities. Preflight rejects an unowned or incompatible
existing account, wrong identity, or unexpected subscription/resource group.
`aspire destroy` is blocked because this resource group also hosts the live bot.

Then deploy the application while explicitly preserving the existing foundation:

```powershell
$env:Parameters__DeploymentScope = 'application'
$env:Parameters__UseExistingFoundation = 'true'
$env:Parameters__GitHubIssuesAppId = '4968096'
$env:Parameters__GitHubIssuesInstallationId = '163850423'
$env:GITHUB_ISSUES_KEY_ID = 'https://aspire-issues-ffccd7.vault.azure.net/keys/github-issues/b4ee9c33666f4abe90b3d9c17d2008bf'
aspire deploy --apphost .\AspireDiscordBot.AppHost\apphost.mts --environment Production --non-interactive
```

`Parameters__GitHubIssuesKeyId` is also accepted. These identifiers are nonsecret.
`UseExistingFoundation` defaults to `false` for legacy deployments; **set it to
`true` for this rollout**. Read-only discovery validates required resources,
ownership, identities and authentication posture, and fails closed instead of
falling back to foundation provisioning. This path skips legacy storage cleanup.

Before cutover, the staged slot must pass health checks plus a bounded read-only smoke check:
the actual GitHub report route, both-repository MCP search, and managed-identity Table access.
The probe never creates an issue, invokes a model, or writes a table row. It runs only in the exact
Discord-disabled staging revision and prints a fixed success/failure marker, not retrieved content.
Any failed or partial lookup stops cutover while the current bot remains active.
The existing lease, immutable build, disabled-Discord staging/readiness check,
singleton cutover, rollback, and superseded-slot cleanup remain in place.
Secret ARM parameters use an owner-protected local file that is removed on success
or failure rather than secret command-line arguments.

Issue policy may explicitly allow all channels and threads of selected Discord servers using
`allowedGuildIds`. For example, an approved policy for the current server can set
`allowedGuildIds: ["1361488941836140614"]` and `allowedChannelIds: []`. This includes future
channels/threads the bot can access, but never DMs or other servers. Existing channel-only policies
remain unchanged; an empty channel list without explicit server IDs still denies access.
The user and repository allowlists, exact-preview approval, original-channel draft binding, and
fresh-policy checks immediately before publication remain mandatory.

Credentials do **not** activate issue filing. Leave
`AspireDiscord:Discord:IssuePolicy` absent or disabled during rollout. Activation is
a separate, explicitly approved App Configuration policy change with nonempty
user/channel/repository allowlists. Existing Q&A allowlist and grounding settings
are never overwritten by deployment (initialization uses `If-None-Match: *`).

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

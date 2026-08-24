# aspire-discord

A Discord bot that answers community questions about **Aspire**, grounded strictly on the
official sources of truth — the [`microsoft/aspire`](https://github.com/microsoft/aspire) and
[`microsoft/aspire.dev`](https://github.com/microsoft/aspire.dev) repositories. It's built
*with* Aspire: an app host orchestrates a Qdrant vector database, a documentation ingestion
worker, and the Discord bot.

Every answer is produced with retrieval-augmented generation (RAG) over the ingested docs and
is **fact-grounded**: if the docs don't cover a question, the bot says so instead of guessing.
It ships with layered safety checks to resist prompt injection and keep the bot
on-topic.

## How it works

```
  aspire docs CLI ──▶ Ingestion ──▶ Qdrant generation collections ◀── Discord bot ◀──▶ Discord
                             │                   ▲                         │
  pinned Git snapshot ───────┘          Ollama embeddings          Copilot SDK agent
                                                                          │
                                                     official GitHub MCP (read-only)
```

1. **Ingestion** reads the published Aspire documentation via the `aspire docs` CLI (the
   authoritative source of truth), cleans the Markdown, splits it into heading-aware overlapping
   chunks, embeds them with a separately configured embedding provider, and builds an isolated
   Qdrant generation. A logical alias moves to the completed generation only after every source
   succeeds, so failed refreshes leave the serving index untouched.
2. **API ingestion** maintains a managed bare mirror of `microsoft/aspire`, resolves `main` to an
   immutable commit, exports only `src`, and uses Roslyn to index the public API surface. Source
   citations point at that exact commit.
3. **The bot** uses the official GitHub Copilot SDK for the default agent runtime. Its custom
   Qdrant tools and the official GitHub MCP server provide grounded documentation, API, source,
   issue, and pull-request evidence.

The ingestion source is configurable — `cli` (default), `github` (reads `.md`/`.mdx` from both
repos), or `local` (on-disk clones). See [Configuration reference](#configuration-reference).

## Projects

| Project | Description |
| --- | --- |
| `AspireDiscordBot.AppHost` | Aspire app host — orchestrates Qdrant + the two services, wires secrets. |
| `AspireDiscordBot.ServiceDefaults` | Shared OpenTelemetry, health checks, and resilience. |
| `AspireDiscordBot.Core` | The RAG pipeline: doc fetch/clean/chunk, embeddings, Qdrant, prompt building, safety. |
| `AspireDiscordBot.Copilot` | Server-safe GitHub Copilot SDK runtime and grounded answer service. |
| `AspireDiscordBot.Ingestion` | Worker that ingests the docs into Qdrant on startup. |
| `AspireDiscordBot.Bot` | The Discord bot (Discord.Net) exposing `/ask` and `@mention` answering. |
| `AspireDiscordBot.Tests` | Unit + integration tests (including a live-Qdrant round trip). |

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/) and the Aspire CLI (`aspire`). The CLI is also
  the default documentation source (`aspire docs`).
- [Git](https://git-scm.com/) for managed, commit-pinned API source snapshots.
- A container runtime (Docker Desktop or Podman) for the Qdrant database.
- **AI access** — by default chat uses the official **GitHub Copilot SDK** and embeddings use the
  AppHost-managed `nomic-embed-text` Ollama model. Azure OpenAI, Azure AI Foundry, OpenAI, and
  fully local Ollama are also supported.
- A **Discord application + bot** (see [Create the Discord bot](#create-the-discord-bot)).

> **Note on GitHub Models:** GitHub Models was retired on **July 30, 2026**. This bot uses
> **GitHub Copilot** (a different service) by default, or Azure OpenAI / OpenAI if you prefer.

## AI access with GitHub Copilot (default)

The default reasoning path uses [`GitHub.Copilot.SDK`](https://github.com/github/copilot-sdk) in
server-safe `Empty` mode. The SDK bundles and manages the Copilot runtime; the bot exposes only its
read-only grounding tools—no ambient shell, filesystem, Git, memory, skill, or plugin tools.

Authentication follows the SDK's supported credential chain:

1. An explicit `COPILOT_GITHUB_TOKEN` (or AppHost `Parameters:CopilotGitHubToken`).
2. An existing GitHub Copilot CLI or `gh` login when `Ai:Copilot:UseLoggedInUser=true` (default).

For local development, sign in with the official CLI tooling or set a short-lived/fine-grained user
token. For unattended services, use the
[documented GitHub App server-to-server flow](https://docs.github.com/en/copilot/how-tos/copilot-sdk/auth/server-to-server-tokens)
and refresh its installation token before expiry.

Copilot and embeddings are deliberately separate. The Copilot SDK has no supported embedding API,
so the default AppHost starts Ollama and pulls `nomic-embed-text`. Production deployments can point
`Ai:EmbeddingProvider` at Azure OpenAI, Azure AI Foundry, or OpenAI instead.


## Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) →
   **New Application**.
2. Open **Bot** → **Add Bot**, then **Reset Token** and copy the token (this is your
   `Discord:Token`).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required only if you
   want the bot to answer `@mentions`; the `/ask` slash command works without it).
4. Under **OAuth2 → URL Generator**, select scopes **`bot`** and **`applications.commands`**,
   grant the **Send Messages**, **Embed Links**, and **Use Slash Commands** permissions (add
   **Read Message History** too if you'll use `@mention` replies), then open the generated URL to
   invite the bot to your server. **Embed Links is required** — the bot always answers with a rich
   embed, so without it replies silently fail.
5. (Optional but recommended for development) Copy your server's **Guild ID** (enable Developer
   Mode in Discord, right-click the server → *Copy Server ID*) and set it as `Discord:GuildId`
   so the `/ask` command registers instantly instead of waiting up to an hour for global
   propagation.

## Configure the bot

On first run, if the Discord bot token isn't already set, Aspire prompts for it in the dashboard
(a single input dialog) and offers to **save it to user-secrets** so later runs don't ask again.
That's the only value Aspire prompts for. Copilot can use an existing supported login; an explicit
token is optional.

You can also set the token (and switch AI provider) ahead of time via user-secrets on the AppHost:

```bash
cd AspireDiscordBot.AppHost

# Discord bot token (the one always-required value; omit to be prompted in the dashboard)
dotnet user-secrets set "Parameters:DiscordToken"     "YOUR-DISCORD-BOT-TOKEN"

# Optional explicit tokens. Keep Copilot billing/auth separate from GitHub MCP repository access.
# dotnet user-secrets set "Parameters:CopilotGitHubToken" "YOUR-COPILOT-CAPABLE-TOKEN"
# dotnet user-secrets set "Parameters:GitHubMcpToken"     "YOUR-READ-ONLY-GITHUB-TOKEN"

# AI provider — default chat is GitHub Copilot SDK. Set these to switch chat/provider:
# dotnet user-secrets set "Parameters:AiProvider"       "azureopenai"   # or azureaifoundry / openai / ollama
# dotnet user-secrets set "Parameters:AiEndpoint"       "https://YOUR-RESOURCE.openai.azure.com"
# dotnet user-secrets set "Parameters:AiApiKey"         "YOUR-AZURE-OPENAI-KEY"
# dotnet user-secrets set "Parameters:AiChatModel"      "gpt-5.6-sol"            # chat model / Azure deployment

# Optional production embedding override (default with Copilot chat is AppHost-managed Ollama):
# dotnet user-secrets set "Parameters:AiEmbeddingProvider"   "azureopenai"
# dotnet user-secrets set "Parameters:AiEmbeddingEndpoint"   "https://YOUR-RESOURCE.openai.azure.com"
# dotnet user-secrets set "Parameters:AiEmbeddingApiKey"     "YOUR-AZURE-OPENAI-KEY"
# dotnet user-secrets set "Parameters:AiEmbeddingModel"      "text-embedding-3-small"
# dotnet user-secrets set "Parameters:AiEmbeddingDimensions" "1536"
```

> For Azure OpenAI, `AiChatModel` / `AiEmbeddingModel` are your **deployment names**, not model
> ids.

## Run it

```bash
cd AspireDiscordBot.AppHost
aspire run           # or: dotnet run
```

The Aspire dashboard opens. On first run:
- If the Discord token isn't set, the dashboard prompts for it — enter it (and optionally save it
  to user-secrets), and the resources continue.
- The AppHost starts Ollama for embeddings and pulls `nomic-embed-text` on first use.
- The **ingestion** worker reads the docs and a pinned source snapshot, builds new Qdrant
  generations, then publishes them through aliases. Existing compatible generations make later
  startups fast; incompatible embedding models or extractor versions rebuild automatically.

Once ingestion completes, ask the bot in Discord:

- Slash command: `/ask question: How do I add a Postgres resource to my app host?`
- Mention: `@YourBot how do resource lifetimes work?`

**Answering on behalf of someone (forum posts & threads).** Inside a forum post or thread, the
`question` is optional — run `/ask` with no question (or a phrase like "please answer the OP's
question above") and the bot reads the **original poster's starter message** and answers that. The
same applies when you `@mention` the bot in a thread with no question. This needs the bot's
**Read Message History** permission and the **Message Content Intent** (see
[Create the Discord bot](#create-the-discord-bot)); without them the bot can't read the OP's post
and will ask you to include a question.

### Restricting the bot to specific users

By default the bot answers everyone. To lock it to yourself (or a small group) while testing, set
`Discord:AllowedUserIds` to one or more Discord user IDs. When the list is non-empty, only those
users get answers — `/ask` from anyone else is **privately declined** (an ephemeral reply only they
see) and mentions from others are ignored.

Get your user ID in Discord: **Settings → Advanced → Developer Mode**, then right-click your name →
**Copy User ID**. Then set it (not a secret, but user-secrets keeps it out of source control):

```bash
cd AspireDiscordBot.Bot
dotnet user-secrets set "Discord:AllowedUserIds:0" "YOUR_DISCORD_USER_ID"
# add more with :1, :2, … or edit appsettings.json's "AllowedUserIds": ["id1", "id2"]
```

Leave `AllowedUserIds` empty to reopen the bot to everyone.

## How answers work (agentic RAG)

The bot doesn't do a single retrieve-then-answer pass. With `Agent:Mode = agentic` (default), it runs
a **tool-calling research loop**: the model plans, calls a `search_docs` tool with focused queries
(several times for multi-part questions), reads the results, searches again where the material is
thin, then synthesizes a grounded, cited answer. This produces markedly deeper answers than
one-shot RAG. Set `Agent:Mode = single` for the classic one-shot pipeline; agentic automatically
falls back to single when the provider can't do tool calling (e.g. Ollama). Tunables live under the
`Agent` section (`MaxIterations`, `MaxToolCalls`, `SearchResultsPerCall`).

### Multiple sources of truth: docs + API surface

The agent grounds answers in more than prose docs. Several retrieval tools back the research loop:

- **`search_docs`** — the official documentation (aspire.dev + microsoft/aspire docs), always on.
- **`search_api`** — the **microsoft/aspire public API surface**: real C# types, method signatures,
  and XML doc comments parsed with Roslyn from an immutable Git snapshot. This answers questions about
  whether an API exists, its exact type/method names, and capabilities the prose docs don't spell
  out (e.g. that `PostgresDatabaseResource`'s `Parent` is the actual container `PostgresServerResource`).
  With `ApiSurface:Enabled=true`, ingestion maintains a bare mirror, resolves `SourceRef`, exports
  only `src`, and stores the result in the separate `aspire_api` Qdrant index. Set
  `LocalSrcPath` only when intentionally overriding the managed snapshot.
- **Official GitHub MCP tools** — `search_code`, `get_file_contents`, `get_repository_tree`,
  `get_commit`, issue/PR search and reads, and release lookup. The remote
  [GitHub MCP server](https://github.com/github/github-mcp-server) runs with read-only mode,
  lockdown mode, an explicit tool allowlist, and application-enforced repository scoping. MCP
  content is always treated as untrusted and potentially outdated. If MCP initialization fails,
  the existing REST code/issue search adapter remains available as a compatibility fallback.

```bash
# Optional local-source override (managed Git snapshots are the default)
cd AspireDiscordBot.Ingestion
dotnet user-secrets set "ApiSurface:LocalSrcPath" "D:\path\to\microsoft-aspire\src"

# Enable official GitHub MCP live research
$env:GITHUB_MCP_TOKEN = "YOUR-READ-ONLY-GITHUB-TOKEN"
```

`ApiSurface` tunables include `RepositoryUrl`, `SourceRef`, `CachePath`, `SnapshotRetention`,
`CollectionName`, and `IncludeProjectPrefixes`. `GitHubMcp` controls the endpoint, tool allowlist,
read-only/lockdown switches, retry cooldown, output bound, and allowed repositories.

### GenAI telemetry in the dashboard
AI and retrieval operations are instrumented with OpenTelemetry following the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so they light up
the Aspire dashboard's [GenAI telemetry visualization](https://aspire.dev/dashboard/explore/#genai-telemetry-visualization).
The SDK runtime plus the application emit model, embeddings, tool-execution, and end-to-end
`gen_ai.*` spans (named e.g. `embeddings nomic-embed-text`, `execute_tool search_docs`,
`invoke_agent aspire-docs-agent`) with model, provider, and token-usage attributes, plus the
`gen_ai.client.token.usage` and `gen_ai.client.operation.duration` metrics. Open a resource's
**Traces** to see the full agent research tree, or **Metrics** for token/latency charts.

**Message content (Input/Output panels).** By default the spans carry metadata + token counts only,
so the dashboard's per-span **Input & output** panels show *"No message content was recorded."* To
capture the actual prompts, retrieved context, tool calls, and model output — rendered in those
panels via the opt-in `gen_ai.input.messages` / `gen_ai.output.messages` / `gen_ai.system_instructions`
attributes — set `Ai:CaptureMessageContent = true` (enabled by default in this repo's bot
`appsettings.json`). It's opt-in because that content is large and includes the user's question and
retrieved documentation; disable it if you'd rather keep telemetry content-free.

## Keeping the index fresh

Ingestion doesn't watch aspire.dev for changes — it refreshes in three ways:

1. **On startup** — the first run populates Qdrant. Later starts skip compatible indexes by checking
   embedding provider/model/dimensions and extractor version, not merely whether points exist.
2. **On a schedule** — a background refresh runs every `Ingestion:RefreshIntervalHours` hours
   (default **24**; set to `0` to disable).
3. **On demand from the Aspire dashboard** — the `ingestion` resource exposes two command
   buttons:
   - **Refresh index** — builds and publishes fresh documentation and API generations.
   - **Force rebuild index** — explicitly resolves fresh source snapshots and re-embeds everything.

   These are backed by `POST /admin/reingest` and `POST /admin/rebuild` on the ingestion service.
   Only one run executes at a time — a request made while a run is in progress is rejected
   (HTTP 409) rather than queued.

Every refresh writes to new physical collections. When all reads and embeddings succeed, Qdrant
atomically moves each logical alias and deletes the previous generation. Deleted pages therefore
disappear automatically; a source/API/embedding failure deletes only staging data.

## API reference (OpenAPI / Scalar)

Both HTTP resources publish an OpenAPI document and a [Scalar](https://scalar.com) API reference UI,
linked from the Aspire dashboard as **API Reference (Scalar)** on each resource:

- **`ingestion`** — documents the admin endpoints (`/admin/reingest`, `/admin/rebuild`,
  `/admin/status`) that back the dashboard command buttons.
- **`bot`** — documents `GET /status`, a live snapshot of the Discord gateway (connection state,
  latency, guild count, whether @mention answering is on, and the signed-in bot user).

For each resource the OpenAPI JSON is served at `/openapi/v1.json` and the Scalar UI at `/scalar`
(open it from the resource's URLs in the dashboard). Health checks (`/health`, `/alive`) are also
exposed in Development.

## Grounding & safety

This bot is designed to only answer Aspire questions, from the docs, and to resist manipulation.

**Grounding**
- Answers are generated **only** from retrieved Aspire documentation, API, source, and explicitly
  labeled issue/pull-request evidence.
- If the best retrieval score is below a threshold, or the model can't answer from the context,
  the bot returns a *"not covered in the Aspire docs"* refusal instead of guessing.
- Every grounded answer includes **source citations** (linking to aspire.dev / GitHub) so users
  can verify.

**Layered safety checks against prompt injection & off-topic steering** — four independent layers,
each verified by tests:
1. **Input guard** (`QuestionSafetyGuard`) — rejects prompt-injection, jailbreak, and
   system-prompt-extraction attempts *before* the model is called, with de-obfuscation of
   spaced/punctuated trigger words.
2. **Topic gating** — the vector store contains **only** Aspire documentation, so an off-topic
   question retrieves nothing above the similarity threshold and is refused. No amount of
   phrasing makes the bot answer about unrelated subjects.
3. **Prompt hardening** (`PromptBuilder`) — the retrieved context and the user question are
   fenced and explicitly marked as **untrusted data**; the system prompt instructs the model to
   never follow instructions found inside them. Delimiter/role-marker spoofing in the input or
   in a poisoned document is sanitized so it can't break out of its region.
4. **Output guard** (`AnswerValidator`) — suppresses any answer that leaks the system prompt or
   shows an injection succeeded.

Tunable knobs live under the `Safety` and `Retrieval` configuration sections
(`MaxQuestionLength`, `MinTopicScore`, `MinScore`, `TopK`, …).

## Choosing an AI provider

Set `Ai:Provider` to one of:

| Provider | `Ai:Provider` | Endpoint / auth | Model fields |
| --- | --- | --- | --- |
| GitHub Copilot SDK (default) | `copilot` | supported CLI login or `COPILOT_GITHUB_TOKEN` | model ids (`gpt-5.6-sol`, …) |
| Azure OpenAI | `azureopenai` | `Ai:Endpoint` + `Ai:ApiKey` (`api-key` header) | deployment names |
| Azure AI Foundry | `azureaifoundry` | `Ai:Endpoint` + `Ai:ApiKey` (`api-key` header) | model ids |
| OpenAI | `openai` | `Ai:Endpoint` + `Ai:ApiKey` (`Bearer`) | model ids |
| Ollama (local) | `ollama` | `Ai:Endpoint` (e.g. `http://localhost:11434`); no key | model ids (`llama3.1`, …) |

`Ai:EmbeddingProvider` selects a documented embedding endpoint independently from chat. It is
required with `copilot`; the AppHost defaults it to orchestrated Ollama. `Ai:EmbeddingEndpoint`,
`Ai:EmbeddingApiKey`, and `Ai:EmbeddingApiVersion` can differ from the chat endpoint/key.

> **Supported APIs only.** Copilot chat uses the official Copilot SDK. Azure OpenAI, Azure AI
> Foundry, and OpenAI chat use the **Responses API**; Ollama uses chat/completions. For reasoning
> models, `Ai:ReasoningEffort` (`low`/`medium`/`high`, default `low`) controls answer depth vs.
> speed/cost, `Ai:Temperature` is ignored (reasoning models allow only the default), and
> `Ai:MaxOutputTokens` must be generous because it also covers the model's internal reasoning
> tokens. Set `Ai:ReasoningEffort` to empty for non-reasoning models (e.g. `gpt-4o`).

> **Embedding dimensions must match the model.** `text-embedding-3-small` = 1536, Ollama's
> `nomic-embed-text` = 768, `mxbai-embed-large` = 1024. Set `Ai:EmbeddingDimensions` accordingly.
> A changed embedding contract is detected automatically and produces a new Qdrant generation.

## Local runs with Ollama

The default Copilot configuration already lets the AppHost orchestrate Ollama for embeddings only.
Two additional configurations are available:

**A. Point at your own Ollama.** Run Ollama yourself and pull the models, then pick `ollama` in
the setup dialog (or set `Parameters:AiProvider=ollama`, `Parameters:AiEndpoint=http://localhost:11434`):

```bash
ollama serve
ollama pull llama3.1          # chat
ollama pull nomic-embed-text  # embeddings (768 dims)
```

**B. Make chat fully local too.** Set `Ollama:Enabled=true`; the AppHost uses Ollama for both chat
and embeddings and pulls both configured models into its persistent model volume.

```bash
cd AspireDiscordBot.AppHost
dotnet user-secrets set "Ollama:Enabled" "true"
# optional overrides:
# dotnet user-secrets set "Ollama:ChatModel" "llama3.1"
# dotnet user-secrets set "Ollama:EmbeddingModel" "nomic-embed-text"
# dotnet user-secrets set "Ollama:EmbeddingDimensions" "768"
```

Switching embedding models or dimensions automatically invalidates and replaces the old generation.

## Configuration reference

The ingestion source is set by `Ingestion:SourceMode`:

```jsonc
// Ingestion project appsettings.json
{
  "Ingestion": {
    "SourceMode": "cli",          // "cli" (default), "github", or "local"
    "CollectionName": "aspire_docs",
    "MaxChunkChars": 1200,
    "ChunkOverlapChars": 150,
    "ForceReindex": false,                    // rebuild on startup
    "SkipStartupIngestWhenPopulated": true,   // skip only a compatible published generation
    "RefreshIntervalHours": 24,               // scheduled refresh; 0 disables it
    "Cli": {
      "ResolveDeepLinks": true,
      "MaxConcurrency": 6,
      "AspireDevLocalPath": "D:/GitHub/aspire.dev" // optional
    }
  },
  "ApiSurface": {
    "Enabled": true,
    "RepositoryUrl": "https://github.com/microsoft/aspire.git",
    "SourceRef": "main",
    "CollectionName": "aspire_api",
    "SnapshotRetention": 3
  }
}
```

- **`cli`** (default) — reads published docs via the `aspire docs` CLI. Citation deep links are
  resolved by matching each page's title to the aspire.dev repo (~93% resolve to an exact page;
  the rest fall back to an aspire.dev search link). Setting `Cli:AspireDevLocalPath` to a local
  clone makes deep-link resolution instant.
- **`github`** — reads `.md`/`.mdx` directly from `microsoft/aspire` and `microsoft/aspire.dev`.
- **`local`** — reads from on-disk clones; set `LocalPath` for each configured source.

`ApiSurface:LocalSrcPath` remains an optional development override. Without it, the worker maintains
an immutable SHA-keyed export under `%LOCALAPPDATA%\AspireDiscordBot\git` (or `ApiSurface:CachePath`).

The bot's live GitHub configuration is intentionally narrow:

```jsonc
"GitHubMcp": {
  "Enabled": true,
  "Endpoint": "https://api.githubcopilot.com/mcp/",
  "ReadOnly": true,
  "Lockdown": true,
  "Tools": ["search_code", "get_file_contents", "get_repository_tree", "get_commit",
            "search_issues", "issue_read", "search_pull_requests", "pull_request_read"],
  "AllowedRepositories": ["microsoft/aspire", "microsoft/aspire.dev"]
}
```

## Tests

```bash
dotnet test
```

Pure tests cover Markdown/chunking, safety, prompts, Roslyn extraction, concurrent citations,
agent-tool budgets, GitHub MCP repository policy/result normalization, the bundled Copilot runtime
transport, managed Git snapshots, and eval scoring. Qdrant integration tests run only when an
endpoint is provided:

```bash
docker run -d --name qdrant -p 6334:6334 -p 6333:6333 qdrant/qdrant
$env:QDRANT_TEST_ENDPOINT = "http://localhost:6334"   # PowerShell
dotnet test
```

Set `GITHUB_MCP_TEST_TOKEN` to include the official remote MCP authentication/tool-list test.

### Answer-quality evals

A curated fixture of real questions (`EvalFixture`) pins the behaviors that matter — deep grounded
answers for covered topics, honest refusals for off-topic questions, and resistance to prompt
injection — so prompt/retrieval/tool changes can't silently regress quality. The scoring logic is
unit-tested; the **live** eval runs the fixture against the real agentic pipeline and asserts a high
pass rate. It's opt-in (skipped in normal CI). With the app's Qdrant running:

```powershell
$env:LIVE_EVAL_QDRANT = "Endpoint=http://localhost:16665;Key=YOUR_QDRANT_KEY"
$env:LIVE_EVAL_EMBEDDING_PROVIDER = "ollama"
$env:LIVE_EVAL_EMBEDDING_ENDPOINT = "http://localhost:11434"
$env:LIVE_EVAL_EMBEDDING_MODEL = "nomic-embed-text"
$env:LIVE_EVAL_EMBEDDING_DIMENSIONS = "768"
$env:LIVE_EVAL_API_SRC = "D:\GitHub\aspire\src"           # optional local override
$env:LIVE_EVAL_GH_TOKEN = (gh auth token)                  # optional GitHub MCP
dotnet test --filter FullyQualifiedName~AnswerQualityEvalTests
```

The test prints a per-case PASS/FAIL report so any regression is easy to pinpoint.

## Package feeds

`nuget.config` pins the two internal feeds that are reachable in this environment and mirror
everything the solution needs (Aspire `13.5.0`, Discord.Net `3.20.1`, the .NET runtime and
`Microsoft.Extensions.*` packages). If you build elsewhere, adjust the feeds to include
`nuget.org`. The new official packages are `GitHub.Copilot.SDK` `1.0.11` and
`ModelContextProtocol` `2.2.0`; the Copilot SDK also acquires its pinned platform runtime during
build unless `CopilotCliBinaryPath` is supplied.

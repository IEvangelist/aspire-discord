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
                 ┌────────────────────────── AppHost (orchestration) ──────────────────────────┐
                 │                                                                              │
  aspire docs ───┼──▶│  Ingestion    │─────▶│    Qdrant    │◀─────────│   Discord Bot     │◀───┼──▶ Discord
  CLI (source    │   │  worker       │ embed│ vector store │  search  │  (/ask + @mention)│    │
   of truth)     │   └───────────────┘      └──────────────┘          └─────────┬─────────┘    │
                 │                                                              │              │
                 │                                   GitHub Copilot (chat + embeddings)        │
                 └──────────────────────────────────────────────────────────────┴─────────────┘
```

1. **Ingestion** reads the published Aspire documentation via the `aspire docs` CLI (the
   authoritative source of truth), cleans the Markdown, splits it into heading-aware overlapping
   chunks, embeds them, and upserts them into Qdrant. Citation URLs are resolved to exact
   aspire.dev deep links by matching page titles to the aspire.dev repo.
2. **The bot** embeds each incoming question, retrieves the most similar chunks, and asks the
   chat model to answer **using only those chunks**, returning the answer with source citations.

The ingestion source is configurable — `cli` (default), `github` (reads `.md`/`.mdx` from both
repos), or `local` (on-disk clones). See [Configuration reference](#configuration-reference).

## Projects

| Project | Description |
| --- | --- |
| `AspireDiscordBot.AppHost` | Aspire app host — orchestrates Qdrant + the two services, wires secrets. |
| `AspireDiscordBot.ServiceDefaults` | Shared OpenTelemetry, health checks, and resilience. |
| `AspireDiscordBot.Core` | The RAG pipeline: doc fetch/clean/chunk, embeddings, Qdrant, prompt building, safety. |
| `AspireDiscordBot.Ingestion` | Worker that ingests the docs into Qdrant on startup. |
| `AspireDiscordBot.Bot` | The Discord bot (Discord.Net) exposing `/ask` and `@mention` answering. |
| `AspireDiscordBot.Tests` | Unit + integration tests (including a live-Qdrant round trip). |

## Prerequisites

- [.NET 10 SDK](https://dotnet.microsoft.com/) and the Aspire CLI (`aspire`). The CLI is also
  the default documentation source (`aspire docs`).
- A container runtime (Docker Desktop or Podman) for the Qdrant database.
- **AI access** — by default the bot uses **GitHub Copilot** and inherits the operator's Copilot
  entitlement via a one-time sign-in (no keys to manage). Azure OpenAI, Azure AI Foundry, and
  OpenAI are also supported — see [Choosing an AI provider](#choosing-an-ai-provider).
- A **Discord application + bot** (see [Create the Discord bot](#create-the-discord-bot)).

> **Note on GitHub Models:** GitHub Models was retired on **July 30, 2026**. This bot uses
> **GitHub Copilot** (a different service) by default, or Azure OpenAI / OpenAI if you prefer.

## AI access with GitHub Copilot (default)

With the default `copilot` provider, the bot signs in to GitHub once using the OAuth
**device flow** and inherits your GitHub Copilot access. The **AppHost drives this sign-in** so the
code and link are surfaced prominently in the Aspire dashboard (via the interaction service) rather
than buried in a service's logs:

1. On first run — when no cached token exists — a **dashboard notification** appears with a link and
   the device code:

   ```
   Sign in to GitHub for Copilot access
     Open https://github.com/login/device and enter code: XXXX-XXXX
   ```

   The notification includes an **Open** link straight to `https://github.com/login/device`. (If the
   AppHost can't reach the interaction service for any reason, the same instructions still print to
   the logs as a fallback.)

2. Open the URL, enter the code, and approve. The OAuth token is cached at
   `~/.aspire-discord/copilot-oauth.json`. The ingestion worker and bot **wait for that shared token**
   instead of prompting themselves, so you sign in exactly once. The device code is re-issued
   automatically if it expires before you approve; the short-lived Copilot token is exchanged and
   refreshed automatically thereafter.

No API keys or endpoints are required for the `copilot` provider.

> **Already signed in?** If a valid `~/.aspire-discord/copilot-oauth.json` is present, no sign-in
> prompt appears and the services start immediately. Delete that file to force a fresh sign-in.

> **Embeddings:** chat always works with your Copilot entitlement. If your account can't reach
> Copilot embeddings, set `Ai:EmbeddingProvider` to another provider (e.g. `azureopenai`) — chat
> stays on Copilot while embeddings use the override.


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
That's the only value you must provide interactively — the default GitHub Copilot provider needs
no keys.

You can also set the token (and switch AI provider) ahead of time via user-secrets on the AppHost:

```bash
cd AspireDiscordBot.AppHost

# Discord bot token (the one always-required value; omit to be prompted in the dashboard)
dotnet user-secrets set "Parameters:DiscordToken"     "YOUR-DISCORD-BOT-TOKEN"

# AI provider — default is GitHub Copilot, which needs NO keys. Only set these to switch provider:
# dotnet user-secrets set "Parameters:AiProvider"       "azureopenai"   # or azureaifoundry / openai / ollama
# dotnet user-secrets set "Parameters:AiEndpoint"       "https://YOUR-RESOURCE.openai.azure.com"
# dotnet user-secrets set "Parameters:AiApiKey"         "YOUR-AZURE-OPENAI-KEY"
# dotnet user-secrets set "Parameters:AiChatModel"      "gpt-5.6-sol"            # chat model / Azure deployment
# dotnet user-secrets set "Parameters:AiEmbeddingModel" "text-embedding-3-small" # embedding model / Azure deployment
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
- If using the default **Copilot** provider, complete the one-time device-flow sign-in from the
  **dashboard notification** that appears on first run (see
  [AI access with GitHub Copilot](#ai-access-with-github-copilot-default)).
- The **ingestion** worker reads the docs via `aspire docs`, embeds them, and upserts to Qdrant
  (a few minutes; watch its logs for `Ingestion finished: N files, M chunks`). Qdrant uses a
  persistent data volume, so subsequent runs reuse the existing index — set
  `Ingestion:ForceReindex=true` to rebuild.

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

### GenAI telemetry in the dashboard

All AI and retrieval operations are instrumented with OpenTelemetry following the
[GenAI semantic conventions](https://opentelemetry.io/docs/specs/semconv/gen-ai/), so they light up
the Aspire dashboard's [GenAI telemetry visualization](https://aspire.dev/dashboard/explore/#genai-telemetry-visualization).
Each chat, embeddings, tool-execution, and end-to-end agent operation emits a `gen_ai.*` span
(named e.g. `chat gpt-5.6-sol`, `embeddings text-embedding-3-small`, `execute_tool search_docs`,
`invoke_agent aspire-docs-agent`) with model, provider, and token-usage attributes, plus the
`gen_ai.client.token.usage` and `gen_ai.client.operation.duration` metrics. Open a resource's
**Traces** to see the full agent research tree, or **Metrics** for token/latency charts.

## Keeping the index fresh

Ingestion doesn't watch aspire.dev for changes — it refreshes in three ways:

1. **On startup** — the first run populates Qdrant. On later restarts the startup ingest is
   **skipped if the index is already populated** (`SkipStartupIngestWhenPopulated`, default true),
   so restarts are fast and don't re-embed everything.
2. **On a schedule** — a background refresh runs every `Ingestion:RefreshIntervalHours` hours
   (default **24**; set to `0` to disable). This is an incremental update (adds/updates pages).
3. **On demand from the Aspire dashboard** — the `ingestion` resource exposes two command
   buttons:
   - **Re-ingest docs** — incremental refresh (adds + updates pages).
   - **Force rebuild index** — drops and rebuilds the whole index (prunes pages deleted from the
     site); asks for confirmation first.

   These are backed by `POST /admin/reingest` and `POST /admin/rebuild` on the ingestion service.
   Only one run executes at a time — a request made while a run is in progress is rejected
   (HTTP 409) rather than queued.

> Incremental refreshes update and add pages but don't remove ones deleted from the site (their
> chunks linger). Use **Force rebuild** for a clean prune.

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
- Answers are generated **only** from retrieved documentation chunks.
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
| GitHub Copilot (default) | `copilot` | device-flow sign-in; no keys | model ids (`gpt-5.6-sol`, …) |
| Azure OpenAI | `azureopenai` | `Ai:Endpoint` + `Ai:ApiKey` (`api-key` header) | deployment names |
| Azure AI Foundry | `azureaifoundry` | `Ai:Endpoint` + `Ai:ApiKey` (`api-key` header) | model ids |
| OpenAI | `openai` | `Ai:Endpoint` + `Ai:ApiKey` (`Bearer`) | model ids |
| Ollama (local) | `ollama` | `Ai:Endpoint` (e.g. `http://localhost:11434`); no key | model ids (`llama3.1`, …) |

`Ai:EmbeddingProvider` optionally overrides the provider for embeddings only (chat keeps
`Ai:Provider`). Useful if your Copilot account lacks embeddings — point embeddings at Azure OpenAI.

> **Modern APIs only.** Chat uses the **Responses API** (`/responses`) — the current surface that
> serves GPT-5-class models like `gpt-5.6-sol` — for Copilot, Azure OpenAI, Azure AI Foundry, and
> OpenAI. (Ollama has no Responses API, so it uses its native chat/completions.) For reasoning
> models, `Ai:ReasoningEffort` (`low`/`medium`/`high`, default `low`) controls answer depth vs.
> speed/cost, `Ai:Temperature` is ignored (reasoning models allow only the default), and
> `Ai:MaxOutputTokens` must be generous because it also covers the model's internal reasoning
> tokens. Set `Ai:ReasoningEffort` to empty for non-reasoning models (e.g. `gpt-4o`).

> **Embedding dimensions must match the model.** `text-embedding-3-small` = 1536, Ollama's
> `nomic-embed-text` = 768, `mxbai-embed-large` = 1024. Set `Ai:EmbeddingDimensions` accordingly.
> Changing it requires a **Force rebuild** of the Qdrant index (the vector size is fixed at
> collection creation).

## Local runs with Ollama

Two ways to use [Ollama](https://ollama.com) for a fully-local, no-cloud setup:

**A. Point at your own Ollama.** Run Ollama yourself and pull the models, then pick `ollama` in
the setup dialog (or set `Parameters:AiProvider=ollama`, `Parameters:AiEndpoint=http://localhost:11434`):

```bash
ollama serve
ollama pull llama3.1          # chat
ollama pull nomic-embed-text  # embeddings (768 dims)
```

**B. Let the AppHost orchestrate Ollama.** Set `Ollama:Enabled=true` on the AppHost and it adds an
`ollama/ollama` container (persistent model volume), wires the services to it, and pulls the
configured models automatically. You're then only prompted for the Discord token.

```bash
cd AspireDiscordBot.AppHost
dotnet user-secrets set "Ollama:Enabled" "true"
# optional overrides:
# dotnet user-secrets set "Ollama:ChatModel" "llama3.1"
# dotnet user-secrets set "Ollama:EmbeddingModel" "nomic-embed-text"
# dotnet user-secrets set "Ollama:EmbeddingDimensions" "768"
```

> Ollama embeddings use different dimensions than the cloud default, so switching to/from Ollama
> requires a **Force rebuild** of the index.

## Configuration reference

The ingestion source is set by `Ingestion:SourceMode`:

```jsonc
// Ingestion project appsettings.json
"Ingestion": {
  "SourceMode": "cli",          // "cli" (default), "github", or "local"
  "CollectionName": "aspire_docs",
  "MaxChunkChars": 1200,
  "ChunkOverlapChars": 150,
  "ForceReindex": false,                    // drop + rebuild on startup
  "SkipStartupIngestWhenPopulated": true,   // fast restarts when the index already exists
  "RefreshIntervalHours": 24,               // scheduled refresh; 0 disables it
  "Cli": {
    "ResolveDeepLinks": true,   // resolve exact aspire.dev URLs for citations
    "MaxConcurrency": 6,        // parallel `aspire docs get` calls
    // Optional: read the deep-link title index from a local aspire.dev clone (instant) instead
    // of GitHub. When unset, titles are fetched from GitHub.
    "AspireDevLocalPath": "D:/GitHub/aspire.dev"
  }
}
```

- **`cli`** (default) — reads published docs via the `aspire docs` CLI. Citation deep links are
  resolved by matching each page's title to the aspire.dev repo (~93% resolve to an exact page;
  the rest fall back to an aspire.dev search link). Setting `Cli:AspireDevLocalPath` to a local
  clone makes deep-link resolution instant.
- **`github`** — reads `.md`/`.mdx` directly from `microsoft/aspire` and `microsoft/aspire.dev`.
- **`local`** — reads from on-disk clones; set `LocalPath` for each configured source.

## Tests

```bash
dotnet test
```

Pure unit tests (Markdown cleaning, chunking, source filtering/URL mapping, the safety guard,
prompt hardening, output validation) always run. The Qdrant and end-to-end pipeline
integration tests run only when a Qdrant endpoint is provided:

```bash
docker run -d --name qdrant -p 6334:6334 -p 6333:6333 qdrant/qdrant
$env:QDRANT_TEST_ENDPOINT = "http://localhost:6334"   # PowerShell
dotnet test
```

## Package feeds

`nuget.config` pins the two internal feeds that are reachable in this environment and mirror
everything the solution needs (Aspire `13.5.0`, Discord.Net `3.20.1`, the .NET runtime and
`Microsoft.Extensions.*` packages). If you build elsewhere, adjust the feeds to include
`nuget.org`.

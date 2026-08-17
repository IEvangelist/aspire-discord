# aspire-discord

A Discord bot that answers community questions about **Aspire**, grounded strictly on the
official sources of truth — the [`microsoft/aspire`](https://github.com/microsoft/aspire) and
[`microsoft/aspire.dev`](https://github.com/microsoft/aspire.dev) repositories. It's built
*with* Aspire: an app host orchestrates a Qdrant vector database, a documentation ingestion
worker, and the Discord bot.

Every answer is produced with retrieval-augmented generation (RAG) over the ingested docs and
is **fact-grounded**: if the docs don't cover a question, the bot says so instead of guessing.
It ships with a defense-in-depth safety layer to resist prompt injection and keep the bot
on-topic.

## How it works

```
                 ┌────────────────────────── AppHost (orchestration) ──────────────────────────┐
                 │                                                                              │
  GitHub /       │   ┌───────────────┐      ┌──────────────┐          ┌───────────────────┐    │
  aspire docs ───┼──▶│  Ingestion    │─────▶│    Qdrant    │◀─────────│   Discord Bot     │◀───┼──▶ Discord
  (source of     │   │  worker       │ embed│ vector store │  search  │  (/ask + @mention)│    │
   truth)        │   └───────────────┘      └──────────────┘          └─────────┬─────────┘    │
                 │                                                              │              │
                 │                                          Azure OpenAI (chat + embeddings)   │
                 └──────────────────────────────────────────────────────────────┴─────────────┘
```

1. **Ingestion** pulls `.md`/`.mdx` docs from both repos, cleans the Markdown/MDX, splits it
   into heading-aware overlapping chunks, embeds them, and upserts them into Qdrant.
2. **The bot** embeds each incoming question, retrieves the most similar chunks, and asks the
   chat model to answer **using only those chunks**, returning the answer with source citations.

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

- [.NET 10 SDK](https://dotnet.microsoft.com/) and the Aspire CLI (`aspire`).
- A container runtime (Docker Desktop or Podman) for the Qdrant database.
- An **Azure OpenAI** resource with a **chat** deployment (e.g. `gpt-4o-mini`) and an
  **embedding** deployment (e.g. `text-embedding-3-small`).
  The AI client is OpenAI-compatible, so OpenAI and Azure AI Foundry also work — see
  [Choosing an AI provider](#choosing-an-ai-provider).
- A **Discord application + bot** (see [Create the Discord bot](#create-the-discord-bot)).

> **Note on GitHub Models:** GitHub Models was retired on **July 30, 2026**, so it is not used.
> Azure OpenAI is the default provider.

## Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) →
   **New Application**.
2. Open **Bot** → **Add Bot**, then **Reset Token** and copy the token (this is your
   `Discord:Token`).
3. Under **Privileged Gateway Intents**, enable **Message Content Intent** (required only if you
   want the bot to answer `@mentions`; the `/ask` slash command works without it).
4. Under **OAuth2 → URL Generator**, select scopes **`bot`** and **`applications.commands`**,
   grant the **Send Messages** and **Use Slash Commands** permissions, then open the generated
   URL to invite the bot to your server.
5. (Optional but recommended for development) Copy your server's **Guild ID** (enable Developer
   Mode in Discord, right-click the server → *Copy Server ID*) and set it as `Discord:GuildId`
   so the `/ask` command registers instantly instead of waiting up to an hour for global
   propagation.

## Configure secrets

Secrets are supplied to the AppHost as parameters. The simplest path for local development is
user-secrets on the AppHost project:

```bash
cd AspireDiscordBot.AppHost

# Azure OpenAI
dotnet user-secrets set "Parameters:AiEndpoint"       "https://YOUR-RESOURCE.openai.azure.com"
dotnet user-secrets set "Parameters:AiApiKey"         "YOUR-AZURE-OPENAI-KEY"
dotnet user-secrets set "Parameters:AiProvider"       "azureopenai"
dotnet user-secrets set "Parameters:AiChatModel"      "gpt-4o-mini"          # your chat *deployment* name
dotnet user-secrets set "Parameters:AiEmbeddingModel" "text-embedding-3-small" # your embedding *deployment* name

# Discord
dotnet user-secrets set "Parameters:DiscordToken"     "YOUR-DISCORD-BOT-TOKEN"
```

> For Azure OpenAI, `AiChatModel` / `AiEmbeddingModel` are your **deployment names**, not model
> ids.

## Run it

```bash
cd AspireDiscordBot.AppHost
aspire run           # or: dotnet run
```

The Aspire dashboard opens. On first run the **ingestion** worker downloads and embeds the docs
(a few minutes; watch its logs for `Ingestion finished: N files, M chunks`). Qdrant uses a
persistent data volume, so subsequent runs reuse the existing index — set
`Ingestion:ForceReindex=true` to rebuild.

Once ingestion completes, ask the bot in Discord:

- Slash command: `/ask question: How do I add a Postgres resource to my app host?`
- Mention: `@YourBot how do resource lifetimes work?`

## Grounding & safety

This bot is designed to only answer Aspire questions, from the docs, and to resist manipulation.

**Grounding**
- Answers are generated **only** from retrieved documentation chunks.
- If the best retrieval score is below a threshold, or the model can't answer from the context,
  the bot returns a *"not covered in the Aspire docs"* refusal instead of guessing.
- Every grounded answer includes **source citations** (linking to aspire.dev / GitHub) so users
  can verify.

**Defense-in-depth against prompt injection & off-topic steering** — four independent layers,
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

| Provider | `Ai:Provider` | `Ai:Endpoint` | Auth header | Model fields |
| --- | --- | --- | --- | --- |
| Azure OpenAI (default) | `azureopenai` | `https://<resource>.openai.azure.com` | `api-key` | deployment names |
| Azure AI Foundry | `azureaifoundry` | your models inference endpoint | `api-key` | model ids |
| OpenAI | `openai` | `https://api.openai.com` | `Bearer` | model ids |

## Configuration reference

The docs source can be switched between GitHub (default, always fresh) and local clones:

```jsonc
// Ingestion project appsettings.json
"Ingestion": {
  "SourceMode": "github",      // or "local"
  "CollectionName": "aspire_docs",
  "MaxChunkChars": 1200,
  "ChunkOverlapChars": 150,
  "ForceReindex": false
}
```

To ingest from local clones instead of GitHub, set `SourceMode` to `local` and provide
`LocalPath` for each configured source.

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
everything the solution needs (Aspire `13.4.6`, Discord.Net `3.20.1`, the .NET runtime and
`Microsoft.Extensions.*` packages). If you build elsewhere, adjust the feeds to include
`nuget.org`.

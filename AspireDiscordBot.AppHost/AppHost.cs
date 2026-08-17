using Aspire.Hosting.ApplicationModel;

var builder = DistributedApplication.CreateBuilder(args);

// --- AI provider configuration ---
// Default provider is "copilot": the bot inherits the operator's GitHub Copilot access via a
// one-time device-flow sign-in (the login URL + code appear in the service logs on first run).
// To use Azure OpenAI / OpenAI instead, set AiProvider and the AiEndpoint/AiApiKey parameters.
var aiProvider = builder.AddParameter("AiProvider", "copilot");
var aiEndpoint = builder.AddParameter("AiEndpoint", "");
var aiApiKey = builder.AddParameter("AiApiKey", "", secret: true);
var aiChatModel = builder.AddParameter("AiChatModel", "gpt-5.6-sol");
var aiEmbeddingModel = builder.AddParameter("AiEmbeddingModel", "text-embedding-3-small");
var discordToken = builder.AddParameter("DiscordToken", "", secret: true);

// --- Qdrant vector database (persisted across runs) ---
var qdrant = builder.AddQdrant("qdrant")
    .WithDataVolume()
    .WithLifetime(ContainerLifetime.Persistent);

// --- Ingestion worker: pulls Aspire docs (source of truth) -> embeds -> Qdrant ---
// Exposes dashboard commands to refresh the index on demand (backed by its /admin endpoints).
builder.AddProject<Projects.AspireDiscordBot_Ingestion>("ingestion")
    .WithHttpEndpoint()
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithEnvironment("Ai__Provider", aiProvider)
    .WithEnvironment("Ai__Endpoint", aiEndpoint)
    .WithEnvironment("Ai__ApiKey", aiApiKey)
    .WithEnvironment("Ai__ChatModel", aiChatModel)
    .WithEnvironment("Ai__EmbeddingModel", aiEmbeddingModel)
    .WithHttpCommand(
        "/admin/reingest",
        "Re-ingest docs",
        endpointName: "http",
        commandOptions: new HttpCommandOptions
        {
            Method = HttpMethod.Post,
            Description = "Re-read the Aspire docs and update the index (incremental).",
            IconName = "ArrowSync",
        })
    .WithHttpCommand(
        "/admin/rebuild",
        "Force rebuild index",
        endpointName: "http",
        commandOptions: new HttpCommandOptions
        {
            Method = HttpMethod.Post,
            Description = "Drop and rebuild the whole index from scratch (prunes deleted pages).",
            IconName = "DatabaseArrowUp",
            ConfirmationMessage = "This drops the current index and re-embeds every page. Continue?",
            IsHighlighted = false,
        });

// --- Discord bot: answers questions grounded in the ingested docs ---
builder.AddProject<Projects.AspireDiscordBot_Bot>("bot")
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithEnvironment("Ai__Provider", aiProvider)
    .WithEnvironment("Ai__Endpoint", aiEndpoint)
    .WithEnvironment("Ai__ApiKey", aiApiKey)
    .WithEnvironment("Ai__ChatModel", aiChatModel)
    .WithEnvironment("Ai__EmbeddingModel", aiEmbeddingModel)
    .WithEnvironment("Discord__Token", discordToken);

builder.Build().Run();

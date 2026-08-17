var builder = DistributedApplication.CreateBuilder(args);

// --- Secrets & configuration (set via user-secrets on this AppHost or the Parameters config section) ---
var aiEndpoint = builder.AddParameter("AiEndpoint");
var aiApiKey = builder.AddParameter("AiApiKey", secret: true);
var aiProvider = builder.AddParameter("AiProvider", "azureopenai");
var aiChatModel = builder.AddParameter("AiChatModel", "gpt-4o-mini");
var aiEmbeddingModel = builder.AddParameter("AiEmbeddingModel", "text-embedding-3-small");
var discordToken = builder.AddParameter("DiscordToken", secret: true);

// --- Qdrant vector database (persisted across runs) ---
var qdrant = builder.AddQdrant("qdrant")
    .WithDataVolume()
    .WithLifetime(ContainerLifetime.Persistent);

// --- Ingestion worker: pulls Aspire docs (source of truth) -> embeds -> Qdrant ---
builder.AddProject<Projects.AspireDiscordBot_Ingestion>("ingestion")
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithEnvironment("Ai__Provider", aiProvider)
    .WithEnvironment("Ai__Endpoint", aiEndpoint)
    .WithEnvironment("Ai__ApiKey", aiApiKey)
    .WithEnvironment("Ai__ChatModel", aiChatModel)
    .WithEnvironment("Ai__EmbeddingModel", aiEmbeddingModel);

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

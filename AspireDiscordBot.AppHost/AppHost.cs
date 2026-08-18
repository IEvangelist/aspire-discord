using Aspire.Hosting.ApplicationModel;
using AspireDiscordBot.AppHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

var builder = DistributedApplication.CreateBuilder(args);

// Optionally orchestrate a local Ollama container for fully-local runs (set "Ollama:Enabled": true,
// e.g. via user-secrets or environment). When enabled, AI is served by this container.
var ollamaEnabled = builder.Configuration.GetValue<bool>("Ollama:Enabled");
var ollamaChatModel = builder.Configuration["Ollama:ChatModel"] ?? "llama3.1";
var ollamaEmbeddingModel = builder.Configuration["Ollama:EmbeddingModel"] ?? "nomic-embed-text";
var ollamaEmbeddingDimensions = builder.Configuration.GetValue("Ollama:EmbeddingDimensions", 768);

// The Discord bot token is the one always-required secret. As an unresolved secret parameter,
// Aspire prompts for it once in the dashboard (a single dialog) when it isn't already provided via
// user-secrets, and offers to save it back to user-secrets so later runs don't prompt.
var discordToken = builder.AddParameter("DiscordToken", secret: true);

// AI settings resolved from configuration with defaults. The default Copilot provider needs no
// endpoint/key, so it stays zero-config. Override any of these via user-secrets on the AppHost,
// e.g. `dotnet user-secrets set "Parameters:AiProvider" "azureopenai"`. Ignored in Ollama mode.
var aiProvider = builder.Configuration["Parameters:AiProvider"] ?? "copilot";
var aiEndpoint = builder.Configuration["Parameters:AiEndpoint"] ?? "";
var aiApiKey = builder.Configuration["Parameters:AiApiKey"] ?? "";
var aiChatModel = builder.Configuration["Parameters:AiChatModel"] ?? "gpt-5.6-sol";
var aiEmbeddingModel = builder.Configuration["Parameters:AiEmbeddingModel"] ?? "text-embedding-3-small";
var aiEmbeddingDimensions = builder.Configuration["Parameters:AiEmbeddingDimensions"] ?? "1536";

// --- Qdrant vector database (persisted across runs) ---
var qdrant = builder.AddQdrant("qdrant")
    .WithDataVolume()
    .WithLifetime(ContainerLifetime.Persistent);

// --- Optional local Ollama server ---
IResourceBuilder<ContainerResource>? ollama = null;
if (ollamaEnabled)
{
    ollama = builder.AddContainer("ollama", "ollama/ollama")
        .WithHttpEndpoint(targetPort: 11434, name: "http")
        .WithVolume("aspire-discord-ollama", "/root/.ollama")
        .WithLifetime(ContainerLifetime.Persistent);

    // Pull the configured models once the server is ready (best-effort, in the background).
    builder.Eventing.Subscribe<ResourceReadyEvent>(ollama.Resource, (evt, ct) =>
    {
        var logger = evt.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Ollama");
        var baseUrl = ollama!.GetEndpoint("http").Url;
        _ = Task.Run(() => OllamaModelPuller.PullAsync(baseUrl, [ollamaChatModel, ollamaEmbeddingModel], logger, ct), ct);
        return Task.CompletedTask;
    });
}

// --- Ingestion worker: pulls Aspire docs (source of truth) -> embeds -> Qdrant ---
// Exposes dashboard commands to refresh the index on demand (backed by its /admin endpoints).
var ingestion = builder.AddProject<Projects.AspireDiscordBot_Ingestion>("ingestion")
    .WithHttpEndpoint()
    .WithReference(qdrant)
    .WaitFor(qdrant)
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
WithAiEnvironment(ingestion);

// --- Discord bot: answers questions grounded in the ingested docs ---
var bot = builder.AddProject<Projects.AspireDiscordBot_Bot>("bot")
    .WithReference(qdrant)
    .WaitFor(qdrant)
    .WithEnvironment("Discord__Token", discordToken)
    .WithAiEnvironment(bot);

if (ollama is not null)
{
    ingestion.WaitFor(ollama);
    bot.WaitFor(ollama);
}

builder.Build().Run();

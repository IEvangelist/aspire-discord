using Aspire.Hosting.ApplicationModel;
using AspireDiscordBot.AppHost;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;

#pragma warning disable ASPIREINTERACTION001 // InteractionInput / PromptInputsAsync are experimental.

var builder = DistributedApplication.CreateBuilder(args);

// Optionally orchestrate a local Ollama container for fully-local runs (set "Ollama:Enabled": true,
// e.g. via user-secrets or environment). When enabled, AI is served by this container and the
// setup dialog only needs the Discord token.
var ollamaEnabled = builder.Configuration.GetValue<bool>("Ollama:Enabled");
var ollamaChatModel = builder.Configuration["Ollama:ChatModel"] ?? "llama3.1";
var ollamaEmbeddingModel = builder.Configuration["Ollama:EmbeddingModel"] ?? "nomic-embed-text";
var ollamaEmbeddingDimensions = builder.Configuration.GetValue("Ollama:EmbeddingDimensions", 768);

// Collects the Discord token + AI settings through a single dashboard dialog on first run.
var setup = new BotSetup(builder.Configuration, ollamaForced: ollamaEnabled);

// Prompt once, before any resource starts (like Aspire's own parameter prompting). The env
// callbacks below then read the already-resolved values synchronously.
if (builder.ExecutionContext.IsRunMode)
{
    builder.Eventing.Subscribe<BeforeStartEvent>(async (evt, cancellationToken) =>
    {
        setup.Interaction = evt.Services.GetService<IInteractionService>();
        await setup.ResolveAsync(cancellationToken);
    });
}

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

// Applies AI settings (and, for the bot, the Discord token) resolved by the setup dialog.
void ApplyRuntimeConfig<T>(IResourceBuilder<T> resource, bool includeDiscordToken)
    where T : IResourceWithEnvironment
{
    resource.WithEnvironment(context =>
    {
        var settings = setup.Current;

        if (ollamaEnabled)
        {
            context.EnvironmentVariables["Ai__Provider"] = "ollama";
            context.EnvironmentVariables["Ai__Endpoint"] = ollama!.GetEndpoint("http");
            context.EnvironmentVariables["Ai__ChatModel"] = ollamaChatModel;
            context.EnvironmentVariables["Ai__EmbeddingModel"] = ollamaEmbeddingModel;
            context.EnvironmentVariables["Ai__EmbeddingDimensions"] = ollamaEmbeddingDimensions.ToString();
        }
        else
        {
            context.EnvironmentVariables["Ai__Provider"] = settings.AiProvider;
            context.EnvironmentVariables["Ai__Endpoint"] = settings.AiEndpoint;
            context.EnvironmentVariables["Ai__ApiKey"] = settings.AiApiKey;
            context.EnvironmentVariables["Ai__ChatModel"] = settings.ChatModel;
            context.EnvironmentVariables["Ai__EmbeddingModel"] = settings.EmbeddingModel;
            context.EnvironmentVariables["Ai__EmbeddingDimensions"] = settings.EmbeddingDimensions.ToString();
        }

        if (includeDiscordToken)
        {
            context.EnvironmentVariables["Discord__Token"] = settings.DiscordToken;
        }
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
ApplyRuntimeConfig(ingestion, includeDiscordToken: false);

// --- Discord bot: answers questions grounded in the ingested docs ---
var bot = builder.AddProject<Projects.AspireDiscordBot_Bot>("bot")
    .WithReference(qdrant)
    .WaitFor(qdrant);
ApplyRuntimeConfig(bot, includeDiscordToken: true);

if (ollama is not null)
{
    ingestion.WaitFor(ollama);
    bot.WaitFor(ollama);
}

var app = builder.Build();
app.Run();
